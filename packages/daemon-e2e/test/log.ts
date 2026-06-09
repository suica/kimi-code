export function createCaseLogger(caseName: string): (label: string, value?: unknown) => void {
  return (label, value) => {
    const prefix = `[daemon-e2e] ${caseName} :: ${label}`;
    if (value === undefined) {
      writeLogLine(prefix);
      return;
    }
    writeLogLine(`${prefix}\n${stringifyForLog(value)}`);
  };
}

export function errorForLog(error: unknown): unknown {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...objectFields(error),
    };
  }
  return error;
}

function objectFields(value: object): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([, field]) => field !== undefined),
  );
}

function stringifyForLog(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function writeLogLine(line: string): void {
  process.stdout.write(`${line}\n`);
}
