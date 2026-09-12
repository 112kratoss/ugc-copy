declare module 'https://deno.land/std@0.224.0/http/server.ts' {
  export function serve(
    handler: (request: Request) => Response | Promise<Response>,
  ): unknown;
}

declare const Deno: {
  env: {
    get(name: string): string | undefined;
  };
};
