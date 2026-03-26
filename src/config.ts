import 'dotenv/config';

const PORT = Number(process.env.PORT) || 4000;
const CORS_ORIGIN = process.env.CORS_ORIGIN?.split(',').map((s) => s.trim()) ?? [
  'http://localhost:3031', // PDV
  'http://localhost:3000', // sax-site
];
const JWT_SECRET = process.env.JWT_SECRET ?? 'dev-secret-change-in-production';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN ?? '7d';

export const config = {
  port: PORT,
  corsOrigin: CORS_ORIGIN,
  jwtSecret: JWT_SECRET,
  jwtExpiresIn: JWT_EXPIRES_IN,
  nodeEnv: process.env.NODE_ENV ?? 'development',
  spaces: {
    endpoint: process.env.DO_SPACES_ENDPOINT ?? '',
    region: process.env.DO_SPACES_REGION ?? 'sfo3',
    key: process.env.DO_SPACES_KEY ?? '',
    secret: process.env.DO_SPACES_SECRET ?? '',
    bucket: process.env.DO_SPACES_BUCKET ?? 'arvis',
    prefix: process.env.DO_SPACES_PREFIX ?? 'sax',
  },
};
