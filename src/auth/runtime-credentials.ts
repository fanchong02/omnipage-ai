export type RuntimeCredentials = {
  email: string;
  password: string;
};

let activeCredentials: RuntimeCredentials | null = null;

export const setRuntimeCredentials = (credentials: RuntimeCredentials | null) => {
  activeCredentials = credentials;
};

export const getRuntimeCredentials = (): RuntimeCredentials | null => activeCredentials;

export const clearRuntimeCredentials = () => {
  activeCredentials = null;
};

export const hasRuntimeCredentials = (): boolean =>
  Boolean(activeCredentials?.email && activeCredentials?.password);
