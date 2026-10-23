/** `vite --mode mock` builds the self-contained mock UI; every other mode talks to the Worker. */
export const MOCK = import.meta.env.MODE === 'mock'
