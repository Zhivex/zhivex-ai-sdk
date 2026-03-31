export const requiredEnv = (name: string): string => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
};

export const section = (title: string) => {
  console.log(`\n=== ${title} ===`);
};
