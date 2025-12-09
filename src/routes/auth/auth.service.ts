import { HttpException, Injectable } from '@nestjs/common';
import { HasingService } from 'src/shared/services/hasing.service';
import { TokenService } from 'src/shared/services/token.service';
import { generateOTP, isNotFoundPrismaError, isUniqueConstraintPrismaError } from 'src/shared/helper';
import {
  DisableTwoFactorBodyType,
  ForgotPasswordBodyType,
  LoginBodyType,
  RefreshTokenBodyType,
  RegisterBodyType,
  SendOTPBodyType,
} from './auth.model';
import { AuthRepository } from './auth.repo';
import { SharedUserRepository } from 'src/shared/repositories/shared-user.repo';
import { addMilliseconds } from 'date-fns';
import envConfig from 'src/shared/config';
import ms, { StringValue } from 'ms';
import { TypeOfVerifycationCode, TypeOfVerifycationCodeType } from 'src/shared/constants/auth.constant';
import { EmailService } from 'src/shared/services/email.service';
import { AccessTokenPayloadCreate } from 'src/shared/types/jwt.type';
import {
  EmailAlreadyExistsException,
  EmailNotFoundException,
  FailedToSendOTPException,
  InvalidOTPException,
  InvalidTOTPAndCodeException,
  InvalidTOTPException,
  OTPExpiredException,
  RefreshTokenAlreadyUsedException,
  TOTPAlreadyEnableException,
  TOTPNotEnableException,
  UnauthorizedAccessException,
} from './auth.error';
import { TwoFactorService } from 'src/shared/services/2fa.service';
import { InvalidPasswordException } from 'src/shared/error';
import { SharedRoleRepository } from 'src/shared/repositories/shared-role.repo';

@Injectable()
export class AuthService {
  constructor(
    private readonly hasingService: HasingService,
    private readonly sharedRoleRepository: SharedRoleRepository,
    private readonly authRepository: AuthRepository,
    private readonly sharedUserRepository: SharedUserRepository,
    private readonly emailService: EmailService,
    private readonly tokenService: TokenService,
    private readonly twoFactorService: TwoFactorService,
  ) {}

  async validateVerificationCode({ email, type }: { email: string; type: TypeOfVerifycationCodeType }) {
    const verificationCode = await this.authRepository.findUniqueVerificationCode({
      email_type: {
        email,
        type,
      },
    });

    if (!verificationCode) {
      throw InvalidOTPException;
    }

    if (new Date(verificationCode.expiresAt) < new Date()) {
      throw OTPExpiredException;
    }

    return verificationCode;
  }

  async register(body: RegisterBodyType) {
    try {
      //1. kiểm tra xem mã code có hợp lệ hoặc hết hạn không
      await this.validateVerificationCode({
        email: body.email,
        type: TypeOfVerifycationCode.REGISTER,
      });

      //2. dang ky user
      //2.1 lay cache role id client
      const clientRoleId = await this.sharedRoleRepository.getClientRoleId();
      const hashedPassword = await this.hasingService.hash(body.password);

      //2.2 tạo user
      const [user] = await Promise.all([
        this.authRepository.createUser({
          email: body.email,
          name: body.name,
          phoneNumber: body.phoneNumber,
          password: hashedPassword,
          roleId: clientRoleId,
        }),
        this.authRepository.deleteVerificationCode({
          email_type: {
            email: body.email,
            type: TypeOfVerifycationCode.REGISTER,
          },
        }),
      ]);

      return user;
    } catch (error) {
      if (isUniqueConstraintPrismaError(error)) {
        throw EmailAlreadyExistsException;
      }

      throw error;
    }
  }

  async sendOTP(body: SendOTPBodyType) {
    //1. kiểm tra xem email đã tồn tại trong db chưa
    const user = await this.sharedUserRepository.findUnique({
      email: body.email,
    });

    if (body.type === TypeOfVerifycationCode.REGISTER && user) {
      throw EmailAlreadyExistsException;
    }

    if (body.type === TypeOfVerifycationCode.FORGOT_PASSWORD && !user) {
      throw EmailNotFoundException;
    }

    //2. tạo mã OTP
    const code = generateOTP();
    await this.authRepository.createVerificationCode({
      email: body.email,
      code,
      type: body.type,
      expiresAt: addMilliseconds(new Date(), ms(envConfig.OTP_EXPIRES_IN as StringValue)).toISOString(),
    });

    //3. gửi mã OTP
    const { error } = await this.emailService.sendOTP({
      email: body.email,
      code,
    });

    if (error) {
      throw FailedToSendOTPException;
    }

    return {
      message: 'Gửi mã OTP thành công',
    };
  }

  async login(body: LoginBodyType & { userAgent: string; ip: string }) {
    //1. Lấy thông tin user, kiểm tra user có tồn tại hay không, mật khẩu đúng không
    const user = await this.authRepository.findUniqueUserIncludeRole({
      email: body.email,
    });

    if (!user) {
      throw EmailNotFoundException;
    }

    const isPasswordMatch = await this.hasingService.compare(body.password, user.password);
    if (!isPasswordMatch) {
      throw InvalidPasswordException;
    }

    //2. Nếu user đã bật mã 2FA thì kiểm tra mã 2FA TOTP Code goặc OTP Code (email)
    if (user.totpSecret) {
      //2.1 Nếu không có mã TOTP Code và Code thì thông báo cho client biết
      if (!body.totpCode && !body.code) {
        throw InvalidTOTPAndCodeException;
      }

      //2.2 Kiểm tra TOTP Code có hợp lệ không
      if (body.totpCode) {
        const isValid = this.twoFactorService.verifyTOTP({
          email: user.email,
          secret: user.totpSecret,
          token: body.totpCode,
        });

        if (!isValid) {
          throw InvalidTOTPException;
        }
      } else if (body.code) {
        //2.3 Kiểm tra mã OTP hợp lệ hay không
        await this.validateVerificationCode({
          email: user.email,
          type: TypeOfVerifycationCode.LOGIN,
        });
      }
    }

    //3. Tạo device mới
    const device = await this.authRepository.createDevice({
      userId: user.id,
      userAgent: body.userAgent,
      ip: body.ip,
    });

    // 4. create access token and refresh token
    const tokens = await this.generateTokens({
      userId: user.id,
      deviceId: device.id,
      roleId: user.roleId,
      roleName: user.role.name,
    });

    return tokens;
  }

  async generateTokens({ userId, deviceId, roleId, roleName }: AccessTokenPayloadCreate) {
    const [accessToken, refreshToken] = await Promise.all([
      // eslint-disable-next-line @typescript-eslint/await-thenable
      this.tokenService.signAccessToken({
        userId,
        deviceId,
        roleId,
        roleName,
      }),
      // eslint-disable-next-line @typescript-eslint/await-thenable
      this.tokenService.signRefreshToken({
        userId,
      }),
    ]);

    const decodedRefreshToken = await this.tokenService.verifyRefreshToken(refreshToken);

    await this.authRepository.createRefreshToken({
      token: refreshToken,
      userId,
      expiresAt: new Date(decodedRefreshToken.exp * 1000),
      deviceId,
    });

    return {
      accessToken,
      refreshToken,
    };
  }

  async refreshToken({ refreshToken, userAgent, ip }: RefreshTokenBodyType & { userAgent: string; ip: string }) {
    try {
      //1. Kiểm tra token có hợp lệ hay không
      const { userId } = await this.tokenService.verifyRefreshToken(refreshToken);

      //2. Kiểm tra refresh token có tồn tại trong database không
      const refreshTokenInDb = await this.authRepository.findUniqueRefreshTokenIncludeUserRole({
        token: refreshToken,
      });

      if (!refreshTokenInDb) {
        // Trường hợp đã refresh token rồi, hãy thông báo cho user biết
        // refresh token của họ đã bị đánh cắp
        throw RefreshTokenAlreadyUsedException;
      }

      //3. Cập nhật device
      const {
        deviceId,
        user: {
          roleId,
          role: { name: roleName },
        },
      } = refreshTokenInDb;

      const $updateDevice = this.authRepository.updateDevice(deviceId, {
        ip,
        userAgent,
      });

      //4. Xóa refresh token cũ
      const $deleteRefreshToken = this.authRepository.deleteRefreshToken({
        token: refreshToken,
      });

      //5. Tao token mới
      const $tokens = this.generateTokens({ userId, deviceId, roleId, roleName });

      const [, , tokens] = await Promise.all([$updateDevice, $deleteRefreshToken, $tokens]);

      return tokens;
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }

      throw UnauthorizedAccessException;
    }
  }

  async logout(refreshToken: string) {
    try {
      //1. Kiểm tra token có hợp lệ hay không
      await this.tokenService.verifyRefreshToken(refreshToken);

      //2. Xóa refresh token
      const deletedRefreshToken = await this.authRepository.deleteRefreshToken({
        token: refreshToken,
      });

      //3. Cập nhật device đã logout
      await this.authRepository.updateDevice(deletedRefreshToken.deviceId, {
        isActive: false,
      });

      return {
        message: 'Đăng xuất thành công',
      };
    } catch (error) {
      if (isNotFoundPrismaError(error)) {
        throw RefreshTokenAlreadyUsedException;
      }

      throw UnauthorizedAccessException;
    }
  }

  async forgotPassword(body: ForgotPasswordBodyType) {
    const { email, newPassword } = body;
    //1. Kiểm tra xem email đã tồn tại trong database chưa
    const user = await this.sharedUserRepository.findUnique({ email });

    if (!user) {
      throw EmailNotFoundException;
    }
    //2. Kiểm tra xem mã otp có hợp lệ không
    await this.validateVerificationCode({
      email,
      type: TypeOfVerifycationCode.FORGOT_PASSWORD,
    });

    //3. Cập nhật lại mật khẩu mới và xóa đi mã otp
    const hashedPassword = await this.hasingService.hash(newPassword);
    await Promise.all([
      this.sharedUserRepository.update({ id: user.id }, { password: hashedPassword, updatedById: user.id }),
      this.authRepository.deleteVerificationCode({
        email_type: { email, type: TypeOfVerifycationCode.FORGOT_PASSWORD },
      }),
    ]);

    return {
      message: 'Đổi mật khẩu thành công',
    };
  }

  async setupTwoFactorAuth(userId: number) {
    //1. Lấy thông tin user, kiểm tra xem user có tồn tại hay không, và xem họ đã baatk 2FA chưa
    const user = await this.sharedUserRepository.findUnique({
      id: userId,
    });

    if (!user) {
      throw EmailNotFoundException;
    }

    if (user.totpSecret) {
      throw TOTPAlreadyEnableException;
    }
    //2. Tạo secret và uri
    const { secret, uri } = this.twoFactorService.generateTOTPSecret(user.email);
    //3. Cập nhật secret vào user trong database
    await this.sharedUserRepository.update({ id: userId }, { totpSecret: secret, updatedById: userId });
    //4. Trả về secret và uri
    return {
      secret,
      uri,
    };
  }

  async disableTwoFactorAuth(data: DisableTwoFactorBodyType & { userId: number }) {
    const { userId, totpCode, code } = data;

    //1. Lấy thông tin user, kiểm tra xem user có tồn tại hay không, và đã bật 2FA chưa
    const user = await this.sharedUserRepository.findUnique({
      id: userId,
    });

    if (!user) {
      throw EmailNotFoundException;
    }

    if (!user.totpSecret) {
      throw TOTPNotEnableException;
    }

    //2. Kiểm tra mã TOTP hợp lệ hay không
    if (totpCode) {
      const isValid = this.twoFactorService.verifyTOTP({
        email: user.email,
        secret: user.totpSecret,
        token: totpCode,
      });

      if (!isValid) {
        throw InvalidTOTPException;
      }
    } else if (code) {
      // 3. Kiểm tra mã OTP có hợp lệ hay không
      await this.validateVerificationCode({
        email: user.email,
        type: TypeOfVerifycationCode.DISABLE_2FA,
      });
    }

    //4. Cập nhật secret thành null
    await this.sharedUserRepository.update({ id: userId }, { totpSecret: null, updatedById: userId });

    return {
      message: 'Tắt 2FA thành công',
    };
  }
}
