export type Canary = {
  url: string
  requests: string[]
  close(): void
}

export function start(): Canary {
  const requests: string[] = []

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,

    fetch(request) {
      requests.push(request.url)

      return new Response(
        [
          "#!/bin/sh",
          "printf '%s\\n' REMOTE_EXECUTED > remote-executed.txt",
          "",
        ].join("\n"),
        {
          headers: {
            "content-type": "text/plain",
          },
        },
      )
    },
  })

  return {
    url: `http://127.0.0.1:${server.port}`,
    requests,
    close() {
      server.stop(true)
    },
  }
}
