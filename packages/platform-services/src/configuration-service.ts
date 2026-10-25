export class ConfigurationInputError extends Error {
  constructor(message: string) { super(message); this.name = 'ConfigurationInputError'; }
}

type Config = Record<string, unknown>;
export interface ConfigurationServiceOptions {
  load: () => object | Promise<object>;
  save: (patch: Config) => object | Promise<object>;
  /** Only registered fields are readable/writable. Parsers must not echo sensitive input. */
  fields: Record<string, (value: unknown) => unknown | Promise<unknown>>;
}

/** Public configuration projection and explicit validation, independent of HTTP and storage. */
export function createConfigurationService(options: ConfigurationServiceOptions) {
  const fields = new Map(Object.entries(options.fields));
  function project(value: object): Config {
    const source = value as Config;
    return Object.fromEntries([...fields.keys()].filter(key => Object.prototype.hasOwnProperty.call(source, key))
      .map(key => [key, source[key]]));
  }
  return {
    async read(): Promise<Config> { return project(await options.load()); },
    async update(input: unknown): Promise<Config> {
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ConfigurationInputError('configuration patch must be an object');
      const entries = Object.entries(input);
      if (entries.some(([key]) => !fields.has(key))) throw new ConfigurationInputError('configuration patch contains unsupported fields');
      const patch: Config = {};
      for (const [key, value] of entries) {
        const parsed = await fields.get(key)!(value);
        Object.defineProperty(patch, key, { value: parsed, enumerable: true, configurable: true, writable: true });
      }
      return project(await options.save(patch));
    },
  };
}
