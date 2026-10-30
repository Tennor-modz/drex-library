export interface BotOptions {
  token: string;
  ownerId?: number | null;
  baseUrl?: string;
  pollTimeout?: number | null;
  quiet?: boolean;
}
export interface Context {
  id: number; chatId: number | null; fromId: number | null; fromUsername: string | null;
  text: string; messageId: number | null; date: string | null; command: string | null;
  receivedAt: number; bot: Bot;
  reply(text: string): Promise<any>;
  replyWithPhoto(url: string, caption?: string): Promise<any>;
}
export class Bot {
  constructor(options: BotOptions);
  me: any;
  on(event: 'message', handler: (ctx: Context) => any): this;
  on(event: 'ready', handler: (me: any) => any): this;
  command(name: string, handler: (ctx: Context) => any): this;
  getMe(): Promise<any>;
  sendMessage(chatId: number | string, text: string): Promise<any>;
  sendPhoto(chatId: number | string, url: string, caption?: string): Promise<any>;
  start(): Promise<this>;
  stop(): this;
}
export function commandName(text: string): string | null;
export const DEFAULT_BASE_URL: string;
