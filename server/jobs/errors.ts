/**
 * A background failure that retrying cannot fix (a capability is turned off, the file has no readable
 * content, the source was deleted upstream…). The runner fails the job at once and shows this message
 * to the user as is, so it must not contain internals.
 */
export class PermanentJobError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PermanentJobError'
  }
}
