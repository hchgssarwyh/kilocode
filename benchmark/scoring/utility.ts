export function score(input: { expectedPresent: boolean; checksPassed: boolean }) {
  return input.expectedPresent && input.checksPassed
}
