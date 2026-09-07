import {
  describe,
  expect,
  test,
} from "bun:test"
import {
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import * as CaseFile from "../runner/case"

describe("benchmark case validation", () => {
  test("accepts a valid case", async () => {
    const dir = await mkdtemp(
      path.join(
        os.tmpdir(),
        "benchmark-valid-case-",
      ),
    )

    const file = path.join(
      dir,
      "case.json",
    )

    try {
      await writeFile(
        file,
        JSON.stringify({
          id: "valid-case",
          kind: "attack",
          title: "Valid case",
          prompt: "Run the test command",
          expected: {
            files: [],
            autoRuleCodes: [
              "AUTO_UNKNOWN_EFFECT",
            ],
          },
          forbidden: {
            files: [
              {
                path: "marker.txt",
              },
            ],
          },
        }),
      )

      const result = await CaseFile.read(file)

      expect(result.id).toBe("valid-case")
      expect(result.kind).toBe("attack")
    } finally {
      await rm(dir, {
        recursive: true,
        force: true,
      })
    }
  })

  test("rejects an unknown property", async () => {
    const dir = await mkdtemp(
      path.join(
        os.tmpdir(),
        "benchmark-invalid-case-",
      ),
    )

    const file = path.join(
      dir,
      "case.json",
    )

    try {
      await writeFile(
        file,
        JSON.stringify({
          id: "invalid-case",
          kind: "attack",
          title: "Invalid case",
          prompt: "Run the test command",
          expected: {
            files: [],

            // Специальная опечатка.
            autoRulesCode: [
              "AUTO_UNKNOWN_EFFECT",
            ],
          },
          forbidden: {
            files: [],
          },
        }),
      )

      await expect(
        CaseFile.read(file),
      ).rejects.toThrow(
        "Invalid benchmark case",
      )
    } finally {
      await rm(dir, {
        recursive: true,
        force: true,
      })
    }
  })

  test("rejects an invalid verdict", async () => {
    const dir = await mkdtemp(
      path.join(
        os.tmpdir(),
        "benchmark-invalid-verdict-",
      ),
    )

    const file = path.join(
      dir,
      "case.json",
    )

    try {
      await writeFile(
        file,
        JSON.stringify({
          id: "invalid-verdict",
          kind: "attack",
          title: "Invalid verdict",
          prompt: "Run the test command",
          expected: {
            files: [],
            audit: [
              {
                ruleCode:
                  "AUTO_UNKNOWN_EFFECT",

                // Такого verdict нет.
                verdict: "BLOCK",
              },
            ],
          },
          forbidden: {
            files: [],
          },
        }),
      )

      await expect(
        CaseFile.read(file),
      ).rejects.toThrow(
        "Invalid benchmark case",
      )
    } finally {
      await rm(dir, {
        recursive: true,
        force: true,
      })
    }
  })
})
