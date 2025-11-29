import zod from 'zod';
import fs from 'fs';
import path from 'path';
import { config } from 'dotenv';

config({
  path: '.env',
});

//Kiểm tra xem có file .env không
if (!fs.existsSync(path.resolve('.env'))) {
  console.log('Không tìm thấy file .env');
  process.exit(1);
}

const configSchema = zod.object({
  DATABASE_URL: zod.string(),
  ACCESS_TOKEN_SECRET: zod.string(),
  ACCESS_TOKEN_EXPIRES_IN: zod.string(),
  REFRESH_TOKEN_SECRET: zod.string(),
  REFRESH_TOKEN_EXPIRES_IN: zod.string(),
  PAYMENT_API_KEY: zod.string(),
  ADMIN_NAME: zod.string(),
  ADMIN_EMAIL: zod.string(),
  ADMIN_PASSWORD: zod.string(),
  ADMIN_PHONENUMBER: zod.string(),
  OTP_EXPIRES_IN: zod.string(),
  RESEND_API_KEY: zod.string(),
  GOOGLE_CLIENT_ID: zod.string(),
  GOOGLE_CLIENT_SECRET: zod.string(),
  GOOGLE_REDIRECT_URL: zod.string(),
  GOOGLE_CLIENT_REDIRECT_URL: zod.string(),
  APP_NAME: zod.string(),
  PREFIX_STATIC_ENDPOINT: zod.string(),
  REDIS_HOST: zod.string(),
  REDIS_PORT: zod.coerce.number(),
});

const configServer = configSchema.safeParse(process.env);

if (!configServer.success) {
  console.log('Các giá trị khai báo trong file .env không hợp lệ');
  console.error(configServer.error);
  process.exit(1);
}

const envConfig = configServer.data;

export default envConfig;
