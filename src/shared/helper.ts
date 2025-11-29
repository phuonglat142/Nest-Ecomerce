import { randomInt } from 'crypto';
import path from 'path';
import { Prisma } from 'src/generated/prisma/client';
import { v4 as uuidv4 } from 'uuid';

//Type predicate: Dự đoán kiểu dữ liệu
export function isUniqueConstraintPrismaError(error: any): error is Prisma.PrismaClientKnownRequestError {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

export function isNotFoundPrismaError(error: any): error is Prisma.PrismaClientKnownRequestError {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025';
}

export function isForeignKeyConstraintPrismaError(error: any): error is Prisma.PrismaClientKnownRequestError {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2003';
}

//Tạo mã OTP
export const generateOTP = () => {
  return String(randomInt(100000, 1000000));
};

//Generate random file name
export const generateRandomFileName = (fileName: string) => {
  const ext = path.extname(fileName);
  return `${uuidv4()}${ext}`;
};

export const generateCancelPaymentJobId = (paymentId: number) => {
  return `cancel-payment-${paymentId}`;
};

export const generateRoomUserId = (userId: number) => {
  return `userId-${userId}`;
};
