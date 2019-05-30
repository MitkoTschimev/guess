import { readFileSync } from 'fs';
import {
  PrefetchConfig,
  PrefetchPluginConfig,
  PrefetchGraph,
  PrefetchNeighbor,
  BundleEntryGraph
} from './declarations';
import { Graph, RoutingModule } from '../../common/interfaces';
import { compressGraph } from './compress';
import { join } from 'path';
import { isInitial, defaultPrefetchConfig, buildMap } from './utils';

const template = require('lodash.template');
const ConcatSource = require('webpack-sources').ConcatSource;

const forEachBlock = (chunk: any, cb: ({ block, chunk }: any) => void) => {
  let blocks: any[] = [];
  if (chunk.groupsIterable) {
    blocks = Array.from(chunk.groupsIterable).reduce(
      (prev: any[], group: any) =>
        prev.concat(
          group.getBlocks().map((block: any) => ({ chunk: group, block }))
        ),
      []
    );
  } else {
    blocks = (chunk.blocks || []).map((block: any) => ({ chunk, block }));
  }
  blocks.forEach(cb);
};

export class PrefetchPlugin {
  constructor(private _config: PrefetchPluginConfig) {
    if (!_config.data) {
      throw new Error('Page graph not provided');
    }
  }

  execute(compilation: any, callback: any) {
    const fileChunk: { [path: string]: string } = {};

    let main: any = null;
    compilation.chunks.forEach((currentChunk: any) => {
      if (isInitial(currentChunk)) {
        main = currentChunk;
      }
      forEachBlock(currentChunk, ({ block, chunk }: any) => {
        let name = (chunk.files || [])
          .filter((f: string) => f.endsWith('.js'))
          .pop();
        if (!name && chunk.chunks && chunk.chunks[0]) {
          name = chunk.chunks[0].files[0];
        }
        fileChunk[block.dependencies[0].module.userRequest] = name;
      });
    });

    if (!main) {
      callback();
      throw new Error('Cannot find the main chunk of the application');
    }

    const newConfig: PrefetchGraph = {};
    const initialGraph = buildMap(this._config.routes, this._config.data, !!this._config.debug);
    Object.keys(initialGraph).forEach(c => {
      newConfig[c] = [];
      initialGraph[c].forEach(p => {
        const newTransition: PrefetchNeighbor = {
          probability: p.probability,
          route: p.route,
          chunk: fileChunk[p.file]
        };
        newConfig[c].push(newTransition);
      });
    });

    const mainName = main.files.filter((f: string) => f.endsWith('.js')).pop();
    const old = compilation.assets[mainName];
    const { graph, graphMap } = compressGraph(newConfig, 3);

    const codeTemplate = 'runtime.tpl';
    const runtimeTemplate = readFileSync(
      join(__dirname, codeTemplate)
    ).toString();

    const runtimeLogic = template(runtimeTemplate)({
      BASE_PATH: this._config.basePath,
      GRAPH: JSON.stringify(graph),
      GRAPH_MAP: JSON.stringify(graphMap),
      THRESHOLDS: JSON.stringify(
        Object.assign({}, defaultPrefetchConfig, this._config.prefetchConfig)
      )
    });

    const MemoryFileSystem = require('memory-fs');
    const memoryFs = new MemoryFileSystem();

    memoryFs.mkdirpSync('/src');
    memoryFs.writeFileSync('/src/index.js', runtimeLogic, 'utf-8');
    memoryFs.writeFileSync(
      '/src/guess.js',
      readFileSync(join(__dirname, 'guess.js')).toString(),
      'utf-8'
    );
    memoryFs.writeFileSync(
      '/src/runtime.js',
      readFileSync(join(__dirname, 'runtime.js')).toString(),
      'utf-8'
    );

    const compiler = require('webpack')({
      context: '/src/',
      mode: 'production',
      entry: './index.js',
      target: 'node',
      output: {
        filename: './output.js'
      }
    });

    compiler.inputFileSystem = memoryFs;
    compiler.outputFileSystem = memoryFs;
    compiler.resolvers.normal.fileSystem = memoryFs;
    compiler.resolvers.context.fileSystem = memoryFs;

    compiler.run((err: any, stats: any) => {
      if (err) {
        callback();
        throw err;
      }

      compilation.assets[mainName] = new ConcatSource(
        stats.compilation.assets['./output.js'],
        '\n',
        old.source()
      );
      callback();
    });
  }
}
