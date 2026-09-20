export const doctorSessionSqliteTestFiles = [
  "src/commands/doctor-session-sqlite.recovery.test.ts",
  "src/commands/doctor-session-sqlite.restore-boundary.test.ts",
  "src/commands/doctor-session-sqlite.restore-historical.test.ts",
  "src/commands/doctor-session-sqlite.restore.test.ts",
  "src/commands/doctor-session-sqlite.retirement.shared.test.ts",
  "src/commands/doctor-session-sqlite.retirement.test.ts",
  "src/commands/doctor-session-sqlite.retirement.verification.test.ts",
  "src/commands/doctor-session-sqlite.test.ts",
];

export function resolveDoctorSessionSqliteTestOwner(file) {
  if (file === "src/commands/doctor-session-sqlite.memory.test.ts") {
    return "memory";
  }
  return doctorSessionSqliteTestFiles.includes(file) ? "sqlite" : undefined;
}
