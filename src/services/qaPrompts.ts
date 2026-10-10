import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  StringSelectMenuBuilder,
  TextChannel,
  TextBasedChannel,
} from 'discord.js';
import * as pendingRequests from './pendingRequests.js';
import type { QuestionRequest, PermissionRequest } from '../types/index.js';

const PENDING_TTL_MS = 15 * 60 * 1000; // 15 minutes

export function permissionLabel(permission: string): string {
  switch (permission) {
    case 'bash':
      return 'bash (comando)';
    case 'edit':
      return 'edición de archivos';
    case 'webfetch':
      return 'fetch web';
    default:
      return permission;
  }
}

export async function disableMessage(
  channel: TextBasedChannel,
  messageId: string,
  note: string,
): Promise<void> {
  try {
    const message = await (channel as TextChannel).messages.fetch(messageId);
    await message.edit({ content: note, components: [] });
  } catch {
    // message may be gone — ignore
  }
}

export async function postQuestion(
  channel: TextBasedChannel,
  port: number,
  request: QuestionRequest,
): Promise<void> {
  if (pendingRequests.getPending(request.id)) return;

  const placeholder: pendingRequests.PendingQuestion = {
    kind: 'question',
    requestID: request.id,
    sessionID: request.sessionID,
    port,
    channelId: channel.id,
    messageId: '',
    createdAt: Date.now(),
    questions: request.questions,
    answers: {},
  };
  pendingRequests.setPending(placeholder);

  const description = request.questions
    .map((q, i) => `**${i + 1}.** ${q.header ? `**${q.header}:** ` : ''}${q.question}`)
    .join('\n');

  const embed = new EmbedBuilder()
    .setTitle('❓ El agente necesita tu respuesta')
    .setDescription(description || 'Respondé la pregunta.')
    .setColor(0x3498db);

  const rows: Array<ActionRowBuilder<StringSelectMenuBuilder>> = [];
  request.questions.slice(0, 5).forEach((q, i) => {
    const options = (q.options ?? []).slice(0, 25);
    if (options.length === 0) return;
    const max = q.multiple ? Math.min(options.length, 25) : 1;
    const select = new StringSelectMenuBuilder()
      .setCustomId(`qsel_${request.id}_${i}`)
      .setPlaceholder(`Respondé la pregunta ${i + 1}`)
      .setMinValues(1)
      .setMaxValues(max)
      .addOptions(
        options.map((o) => ({
          label: o.label.slice(0, 25),
          description: o.description ? o.description.slice(0, 100) : undefined,
          value: o.label,
        })),
      );
    rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select));
  });

  const actionRow = new ActionRowBuilder<ButtonBuilder>();
  request.questions.forEach((q, i) => {
    if (q.custom && i < 5) {
      actionRow.addComponents(
        new ButtonBuilder()
          .setCustomId(`qother_${request.id}_${i}`)
          .setLabel('✏️ Otra respuesta')
          .setStyle(ButtonStyle.Secondary),
      );
    }
  });
  actionRow.addComponents(
    new ButtonBuilder()
      .setCustomId(`qreject_${request.id}`)
      .setLabel('❌ Cancelar')
      .setStyle(ButtonStyle.Danger),
  );

  try {
    const message = await (channel as TextChannel).send({ embeds: [embed], components: [...rows, actionRow] });
    placeholder.messageId = message.id;
    placeholder.timer = setTimeout(() => {
      pendingRequests.deletePending(request.id);
      void disableMessage(channel, message.id, '❓ Pregunta **expiró** (15 min).');
    }, PENDING_TTL_MS);
  } catch (error) {
    pendingRequests.deletePending(request.id);
    console.error('[qa] Failed to post question:', error);
  }
}

export async function postPermission(
  channel: TextBasedChannel,
  port: number,
  request: PermissionRequest,
): Promise<void> {
  if (pendingRequests.getPending(request.id)) return;

  const permission = request.permission || request.action || 'unknown';
  const resources = request.resources ?? request.patterns ?? [];
  const metadata = request.metadata ?? {};

  const placeholder: pendingRequests.PendingPermission = {
    kind: 'permission',
    requestID: request.id,
    sessionID: request.sessionID,
    port,
    channelId: channel.id,
    messageId: '',
    createdAt: Date.now(),
    permission,
  };
  pendingRequests.setPending(placeholder);

  const embed = new EmbedBuilder()
    .setTitle('🔐 Permiso requerido')
    .setDescription(
      `El agente quiere ejecutar: **${permissionLabel(permission)}**${resources.length ? `\nRecursos: \`${resources.join('`, `')}\`` : ''}`,
    )
    .setColor(0xf1c40f);

  const command = metadata.command ?? metadata.cmd ?? metadata.description;
  if (typeof command === 'string' && command.trim()) {
    embed.addFields({ name: 'Comando', value: `\`\`\`\n${command.slice(0, 1900)}\n\`\`\`` });
  }

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`preply_${request.id}_once`)
      .setLabel('✅ Permitir')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`preply_${request.id}_always`)
      .setLabel('🔁 Siempre')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`preply_${request.id}_reject`)
      .setLabel('❌ Rechazar')
      .setStyle(ButtonStyle.Danger),
  );

  try {
    const message = await (channel as TextChannel).send({ embeds: [embed], components: [row] });
    placeholder.messageId = message.id;
    placeholder.timer = setTimeout(() => {
      pendingRequests.deletePending(request.id);
      void disableMessage(channel, message.id, '🔐 Permiso **expiró** (15 min).');
    }, PENDING_TTL_MS);
  } catch (error) {
    pendingRequests.deletePending(request.id);
    console.error('[qa] Failed to post permission:', error);
  }
}
