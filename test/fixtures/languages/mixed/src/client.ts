export class Client {
  request(path: string): Promise<string> {
    return Promise.resolve(path);
  }
}
