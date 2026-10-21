/** Fatal storage/schema problems; the process must exit without listening. */
export class StorageSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StorageSchemaError';
  }
}
