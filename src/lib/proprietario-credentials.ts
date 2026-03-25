import { createHash, randomInt, randomUUID } from 'crypto';
import nodemailer from 'nodemailer';
import { Prisma } from '@prisma/client';

import { prisma } from './prisma.js';

function prismaRequestErrorCode(e: unknown): string {
  if (typeof e === 'object' && e !== null && 'code' in e) {
    const c = (e as { code?: unknown }).code;
    return typeof c === 'string' ? c : '';
  }
  return '';
}

/** Garante tabela de deduplicação (evita depender só de migrate; idempotente). */
async function ensureIssuedPortalPasswordTable() {
  await prisma.$executeRaw(Prisma.sql`
    CREATE TABLE IF NOT EXISTS "IssuedPortalPassword" (
      "id" TEXT NOT NULL,
      "sha256_hex" TEXT NOT NULL,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "IssuedPortalPassword_pkey" PRIMARY KEY ("id")
    )
  `);
  await prisma.$executeRaw(Prisma.sql`
    CREATE UNIQUE INDEX IF NOT EXISTS "IssuedPortalPassword_sha256_hex_key"
    ON "IssuedPortalPassword"("sha256_hex")
  `);
}

/** Senha com letras e números (evita caracteres ambíguos). */
export function generateProvisionalPassword(): string {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz';
  const digits = '23456789';
  const chars: string[] = [];
  for (let i = 0; i < 8; i += 1) chars.push(letters[randomInt(letters.length)]);
  for (let i = 0; i < 8; i += 1) chars.push(digits[randomInt(digits.length)]);
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

/**
 * Gera senha e registra SHA-256 em IssuedPortalPassword para não repetir o mesmo texto.
 */
export async function generateUniqueProvisionalPassword(): Promise<string> {
  await ensureIssuedPortalPasswordTable();
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const pwd = generateProvisionalPassword();
    const sha256Hex = createHash('sha256').update(pwd, 'utf8').digest('hex');
    try {
      await prisma.$executeRaw(
        Prisma.sql`INSERT INTO "IssuedPortalPassword" ("id", "sha256_hex", "createdAt") VALUES (${randomUUID()}, ${sha256Hex}, NOW())`,
      );
      return pwd;
    } catch (e: unknown) {
      const code = prismaRequestErrorCode(e);
      if (code === 'P2002') continue;
      // P2010 = falha em raw SQL (ex.: permissão / tabela ainda inexistente em edge cases)
      if (code === 'P2010') {
        console.warn(
          '[proprietario-credentials] INSERT em IssuedPortalPassword falhou; senha gerada sem registro no banco.',
        );
        return pwd;
      }
      console.warn('[proprietario-credentials] IssuedPortalPassword indisponível, retornando senha sem registro:', e);
      return pwd;
    }
  }
  throw new Error('Não foi possível gerar senha provisória única');
}

export type NotifyCredentialsInput = {
  send_email?: boolean;
  send_whatsapp?: boolean;
  email_to?: string | null;
  whatsapp_phone?: string | null;
  /** URL base do site (ex.: https://www.sax.com.br) — usada na mensagem */
  portal_base_url?: string | null;
};

export function parseNotifyCredentials(body: Record<string, unknown>): NotifyCredentialsInput | null {
  const raw = body.notify_credentials ?? body.notifyCredentials;
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  return {
    send_email: o.send_email === true || o.send_email === '1' || o.send_email === 1,
    send_whatsapp: o.send_whatsapp === true || o.send_whatsapp === '1' || o.send_whatsapp === 1,
    email_to: typeof o.email_to === 'string' ? o.email_to.trim() : null,
    whatsapp_phone: typeof o.whatsapp_phone === 'string' ? o.whatsapp_phone.trim() : null,
    portal_base_url: typeof o.portal_base_url === 'string' ? o.portal_base_url.trim().replace(/\/$/, '') : null,
  };
}

function buildCredentialMessage(params: {
  nome: string;
  portalBaseUrl: string;
  subdomain: string;
  accessEmail: string;
  password: string;
}): string {
  const loginUrl = `${params.portalBaseUrl}/para-proprietarios`;
  return [
    `Olá ${params.nome},`,
    '',
    'Seu acesso ao painel do proprietário SAX foi configurado.',
    '',
    `Link do portal: ${loginUrl}`,
    `Subdomínio (no login): ${params.subdomain}`,
    `E-mail de acesso: ${params.accessEmail}`,
    `Senha provisória: ${params.password}`,
    '',
    'Recomendamos alterar a senha no primeiro acesso, se solicitado.',
    '',
    'Equipe SAX',
  ].join('\n');
}

function digitsOnlyPhone(phone: string): string {
  return phone.replace(/\D/g, '');
}

export function buildWhatsAppLink(phone: string, message: string): string {
  const n = digitsOnlyPhone(phone);
  if (!n) return '';
  const text = encodeURIComponent(message);
  return `https://wa.me/${n}?text=${text}`;
}

async function sendSmtpEmail(params: { to: string; subject: string; text: string }): Promise<void> {
  const host = process.env.SMTP_HOST?.trim();
  const port = Number(process.env.SMTP_PORT || '587');
  const user = process.env.SMTP_USER?.trim();
  const pass = process.env.SMTP_PASS ?? '';
  const from = process.env.SMTP_FROM?.trim() || user;
  if (!host || !from) {
    throw new Error('SMTP não configurado (SMTP_HOST / SMTP_FROM)');
  }
  const transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: user ? { user, pass } : undefined,
  });
  await transporter.sendMail({
    from,
    to: params.to,
    subject: params.subject,
    text: params.text,
  });
}

export type DispatchCredentialResult = {
  emailSent: boolean;
  emailError?: string;
  whatsappUrl: string | null;
};

export async function dispatchProprietarioCredentialNotifications(opts: {
  nome: string;
  passwordPlain: string;
  accessEmail: string;
  subdomain: string;
  notify: NotifyCredentialsInput;
}): Promise<DispatchCredentialResult> {
  const portalBase =
    opts.notify.portal_base_url ||
    process.env.OWNER_PORTAL_BASE_URL?.trim() ||
    process.env.NEXT_PUBLIC_SITE_URL?.trim() ||
    'https://localhost';
  const msg = buildCredentialMessage({
    nome: opts.nome,
    portalBaseUrl: portalBase,
    subdomain: opts.subdomain,
    accessEmail: opts.accessEmail,
    password: opts.passwordPlain,
  });

  let emailSent = false;
  let emailError: string | undefined;
  if (opts.notify.send_email) {
    const to = opts.notify.email_to || opts.accessEmail;
    if (to) {
      try {
        await sendSmtpEmail({
          to,
          subject: 'Acesso ao painel do proprietário SAX',
          text: msg,
        });
        emailSent = true;
      } catch (e) {
        emailError = e instanceof Error ? e.message : 'Erro ao enviar e-mail';
      }
    } else {
      emailError = 'E-mail de destino não informado';
    }
  }

  let whatsappUrl: string | null = null;
  if (opts.notify.send_whatsapp && opts.notify.whatsapp_phone) {
    whatsappUrl = buildWhatsAppLink(opts.notify.whatsapp_phone, msg);
  }

  return { emailSent, emailError, whatsappUrl };
}
