import { EventEmitter } from 'events';
import type { Config, Logger } from './types';

export const VERSION = '1.0.0';
const MAX_RETRIES = 3;

export interface IPlugin {
  name: string;
  init(): Promise<void>;
}

export interface IServiceConfig {
  port: number;
  host: string;
  debug?: boolean;
}

export enum Status {
  Active = 'active',
  Idle = 'idle',
  Stopped = 'stopped',
}

export type Handler = (req: Request, res: Response) => Promise<void>;

export class Service extends EventEmitter implements IPlugin {
  name = 'synapse-service';
  private logger: Logger;
  private config: IServiceConfig;

  constructor(config: IServiceConfig) {
    super();
    this.config = config;
    this.logger = console;
  }

  async init(): Promise<void> {
    this.logger.info('Initializing...');
  }

  async start(): Promise<void> {
    this.emit('start');
  }

  private validate(input: string): boolean {
    return input.length > 0;
  }

  static create(config: IServiceConfig): Service {
    return new Service(config);
  }
}

export function createHandler(name: string): Handler {
  return async (req, res) => {
    // TODO: implement proper error handling
    res.send({ name });
  };
}

export const defaultConfig: IServiceConfig = {
  port: 3000,
  host: 'localhost',
};

// FIXME: memory leak in event listener
