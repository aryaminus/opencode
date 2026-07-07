import { type AstNode, InterpreterRuntimeError } from "../interpreter/model.js"
import { copyIn, copyOut } from "../tool-runtime.js"

export const jsonStatics = new Set(["stringify", "parse"])

export const invokeJsonMethod = (name: string, args: Array<unknown>, node: AstNode): unknown => {
  if (!jsonStatics.has(name)) throw new InterpreterRuntimeError(`JSON.${name} is not available in CodeMode.`, node)
  switch (name) {
    case "stringify": {
      const space = args[2]
      const indent = typeof space === "number" || typeof space === "string" ? space : undefined
      return JSON.stringify(
        copyOut(copyIn(args[0], "JSON.stringify value")),
        Array.isArray(args[1]) ? args[1] : null,
        indent,
      )
    }
    case "parse": {
      const text = args[0]
      if (typeof text !== "string") throw new InterpreterRuntimeError("JSON.parse expects a string.", node)
      try {
        return copyIn(JSON.parse(text), "JSON.parse result")
      } catch (error) {
        throw new InterpreterRuntimeError(
          `JSON.parse received invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
          node,
        ).as("SyntaxError")
      }
    }
  }
  throw new InterpreterRuntimeError(`JSON.${name} is not available in CodeMode.`, node)
}
