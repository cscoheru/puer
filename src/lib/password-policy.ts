/**
 * 密码强度规则 —— **只有一份**。
 *
 * 注册与「自助重置密码」必须用同一套标准：用户注册时定了什么标准，
 * 改密码时就该是同一个标准。分叉的话，用户注册时被要求 8 位带数字，
 * 改密码时却只被要求 6 位 —— 或者反过来。
 */
import { z } from "zod";

/** 密码最少几位。 */
export const PASSWORD_MIN_LENGTH = 8;

/** 密码规则：≥8 位 + 至少一个字母 + 至少一个数字。 */
export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `密码至少 ${PASSWORD_MIN_LENGTH} 个字符`)
  .regex(/[a-zA-Z]/, "密码必须包含至少一个字母")
  .regex(/[0-9]/, "密码必须包含至少一个数字");
