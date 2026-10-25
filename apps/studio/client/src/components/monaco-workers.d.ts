/** Vite builds these imports into local worker assets, including in package consumers. */
declare module 'monaco-editor/*?worker' {
  const WorkerConstructor: new () => Worker;
  export default WorkerConstructor;
}
