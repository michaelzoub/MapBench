export interface HttpRequest {
  body: unknown;
}

export interface HttpResponse {
  status: number;
  body: unknown;
}

export type RouteHandler = (request: HttpRequest) => Promise<HttpResponse>;

export class HttpRouter {
  private readonly routes = new Map<string, RouteHandler>();

  post(path: string, handler: RouteHandler): void {
    this.routes.set(`POST ${path}`, handler);
  }

  async dispatch(method: string, path: string, request: HttpRequest): Promise<HttpResponse> {
    const handler = this.routes.get(`${method} ${path}`);
    if (!handler) return { status: 404, body: { error: "not found" } };
    return await handler(request);
  }
}
