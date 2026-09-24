/** A setup failure the settings page shows with a manual fix command. */
export class SetupError extends Error {
  readonly fixCommand: string | null;
  constructor(message: string, fixCommand: string | null = null) {
    super(message);
    this.fixCommand = fixCommand;
  }
}
