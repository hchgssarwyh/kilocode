export function option(argv: readonly string[], name: string) {
  const index = argv.indexOf(`--${name}`)
  if (index < 0) return
  return argv.at(index + 1)
}
