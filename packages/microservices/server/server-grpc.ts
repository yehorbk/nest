import { InvalidGrpcPackageException } from '../exceptions/invalid-grpc-package.exception';
import { InvalidProtoDefinitionException } from '../exceptions/invalid-proto-definition.exception';
import { GrpcOptions, MicroserviceOptions } from '../interfaces/microservice-configuration.interface';
import { GRPC_DEFAULT_URL } from './../constants';
import { CustomTransportStrategy } from './../interfaces';
import { Server } from './server';

let grpcPackage: any = {};

export class ServerGrpc extends Server implements CustomTransportStrategy {
  private readonly url: string;
  private grpcClient: any;

  constructor(private readonly options: MicroserviceOptions) {
    super();
    this.url =
      this.getOptionsProp<GrpcOptions>(options, 'url') || GRPC_DEFAULT_URL;

    grpcPackage = this.loadPackage('grpc', ServerGrpc.name);
  }

  public async listen(callback: () => void) {
    this.grpcClient = this.createClient();
    await this.start(callback);
  }

  public async start(callback?: () => void) {
    await this.bindEvents();
    this.grpcClient.start();
    callback();
  }

  public async bindEvents() {
    const grpcContext = this.loadProto();
    const packageName = this.getOptionsProp<GrpcOptions>(
      this.options,
      'package',
    );
    const grpcPkg = this.lookupPackage(grpcContext, packageName);
    if (!grpcPkg) {
      const invalidPackageError = new InvalidGrpcPackageException();
      this.logger.error(invalidPackageError.message, invalidPackageError.stack);
      throw invalidPackageError;
    }
    for (const name of this.getServiceNames(grpcPkg)) {
      this.grpcClient.addService(
        grpcPkg[name].service,
        await this.createService(grpcPkg[name], name),
      );
    }
  }

  public getServiceNames(grpcPkg: any) {
    return Object.keys(grpcPkg).filter(name => grpcPkg[name].service);
  }

  public async createService(grpcService: any, name: string) {
    const service = {};

    // tslint:disable-next-line:forin
    for (const methodName in grpcService.prototype) {
      const methodHandler = this.messageHandlers[
        this.createPattern(name, methodName)
      ];
      if (!methodHandler) {
        continue;
      }
      service[methodName] = await this.createServiceMethod(
        methodHandler,
        grpcService.prototype[methodName],
      );
    }
    return service;
  }

  public createPattern(service: string, methodName: string): string {
    return JSON.stringify({
      service,
      rpc: methodName,
    });
  }

  public createServiceMethod(
    methodHandler: Function,
    protoNativeHandler: any,
  ): Function {
    return protoNativeHandler.responseStream
      ? this.createStreamServiceMethod(methodHandler)
      : this.createUnaryServiceMethod(methodHandler);
  }

  public createUnaryServiceMethod(methodHandler): Function {
    return async (call, callback) => {
      const handler = methodHandler(call.request, call.metadata);
      this.transformToObservable(await handler).subscribe(
        data => callback(null, data),
        err => callback(err),
      );
    };
  }

  public createStreamServiceMethod(methodHandler): Function {
    return async (call, callback) => {
      const handler = methodHandler(call.request, call.metadata);
      const result$ = this.transformToObservable(await handler);
      await result$.forEach(data => call.write(data));
      call.end();
    };
  }

  public close() {
    this.grpcClient && this.grpcClient.forceShutdown();
    this.grpcClient = null;
  }

  public deserialize(obj): any {
    try {
      return JSON.parse(obj);
    } catch (e) {
      return obj;
    }
  }

  public createClient(): any {
    const server = new grpcPackage.Server();
    const credentials = this.getOptionsProp<GrpcOptions>(
      this.options,
      'credentials',
    );
    server.bind(
      this.url,
      credentials || grpcPackage.ServerCredentials.createInsecure(),
    );
    return server;
  }

  public lookupPackage(root: any, packageName: string) {
    /** Reference: https://github.com/kondi/rxjs-grpc */
    let pkg = root;
    for (const name of packageName.split(/\./)) {
      pkg = pkg[name];
    }
    return pkg;
  }

  public loadProto(): any {
    try {
      const root = this.getOptionsProp<GrpcOptions>(this.options, 'root');
      const file = this.getOptionsProp<GrpcOptions>(this.options, 'protoPath');
      const options = root ? { root, file } : file;

      const context = grpcPackage.load(options);
      return context;
    } catch (e) {
      const invalidProtoError = new InvalidProtoDefinitionException();
      this.logger.error(invalidProtoError.message, invalidProtoError.stack);
      throw invalidProtoError;
    }
  }
}