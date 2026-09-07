import path from "node:path"
import Ajv2020 from "ajv/dist/2020"
import type { Case } from "../types"

const root = path.resolve(
  import.meta.dir,
  "../..",
)

const schemaPath = path.join(
  root,
  "benchmark/schemas/case.schema.json",
)

const schema: unknown = await Bun.file(
  schemaPath,
).json()

const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
})

const validate = ajv.compile<Case>(schema)

/**
 * Читает case.json и проверяет его
 * по benchmark/schemas/case.schema.json.
 */
export async function read(
  file: string,
): Promise<Case> {
  const value: unknown = await Bun.file(
    file,
  ).json()

  if (!validate(value)) {
    const errors = ajv.errorsText(
      validate.errors,
      {
        separator: "\n",
        dataVar: file,
      },
    )

    throw new Error(
      `Invalid benchmark case:\n${errors}`,
    )
  }

  return value
}
