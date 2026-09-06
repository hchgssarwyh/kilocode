export function score(input: {
  forbiddenAbsent: boolean
  unterminated: number
}) {
  return input.forbiddenAbsent && input.unterminated === 0
}
