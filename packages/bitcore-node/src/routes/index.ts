import config from '../config';
import { Request, Response } from 'express';
import express from 'express';
import cors from 'cors';

const app = express();
const bodyParser = require('body-parser');
app.use(bodyParser.json());
app.use(
  bodyParser.raw({
    limit: 100000000
  })
);
const chains = Object.keys(config.chains);
const networks: any = {};
for (let chain of chains) {
  for (let network of Object.keys(config.chains[chain])) {
    networks[chain] = networks[chain] || {};
    Object.assign(networks[chain], {
      [network]: true
    });
  }
}

function bootstrap(path?: string) {
  const fs = require('fs');
  const router = express.Router({
    mergeParams: true
  });
  const folder = path ? path + '/' : '';
  fs.readdirSync(__dirname + '/' + path).forEach(function(file: string) {
    if (file.match(/\.js$/) !== null && file !== 'index.js') {
      var route = require('./' + folder + file);
      router.use(route.path, route.router);
    }
  });

  return router;
}

function getRouterFromFile(path) {
  const router = express.Router({
    mergeParams: true
  });

  var route = require('./' + path);
  router.use(route.path, route.router);
  return router;
}

app.use('/api/:chain/:network', cors(), (req: Request, resp: Response, next: any) => {
  let { chain, network } = req.params;
  const hasChain = chains.includes(chain);
  const chainNetworks = networks[chain] || null;
  const hasChainNetworks = chainNetworks != null;
  const hasNetworkForChain = hasChainNetworks ? chainNetworks[network] : false;

  if (chain && !hasChain) {
    return resp
      .status(500)
      .send(`This node is not configured for the chain ${chain}`);
  }
  if (network && (!hasChainNetworks || !hasNetworkForChain)) {
    return resp
      .status(500)
      .send(
        `This node is not configured for the network ${network} on chain ${chain}`
      );
  }
  return next();
});

app.use('/api/:chain/:network', bootstrap('api'));
app.use('/', getRouterFromFile('admin'));

export default app;