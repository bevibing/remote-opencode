import {
  ButtonInteraction,
  StringSelectMenuInteraction,
  ModalSubmitInteraction,
  ThreadChannel,
  MessageFlags,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import type { QuestionItem, QuestionRequest } from '../types/index.js';
import * as sessionManager from '../services/sessionManager.js';
import * as serveManager from '../services/serveManager.js';
import * as dataStore from '../services/dataStore.js';
import * as worktreeManager from '../services/worktreeManager.js';

const pendingAnswers = new Map<string, Map<number, string[]>>();
const pendingPage = new Map<string, number>();

export function setPendingAnswers(key: string, selections: Map<number, string[]>): void {
  pendingAnswers.set(key, selections);
}

export function setPendingPage(key: string, page: number): void {
  pendingPage.set(key, page);
}

function clearPendingAnswers(key: string): void {
  pendingAnswers.delete(key);
  pendingPage.delete(key);
}

function countQuestionRows(question: QuestionItem): number {
  const options = question.options ?? [];
  const hasCustom = question.custom !== false;
  if (options.length === 0) return 1;
  const totalSlots = options.length + (hasCustom ? 1 : 0);
  const useSelect = question.multiple === true || options.length > 5 || totalSlots > 5;
  if (useSelect && hasCustom) return 2;
  return 1;
}

function computePageSlice(
  questions: QuestionItem[],
  page: number,
  questionRows: number,
): { start: number; end: number; maxPage: number } {
  let totalPages = 0;
  {
    let idx = 0;
    while (idx < questions.length) {
      let used = 0;
      while (used < questionRows && idx < questions.length) {
        const qRows = countQuestionRows(questions[idx]);
        if (used + qRows > questionRows) break;
        used += qRows;
        idx++;
      }
      totalPages++;
    }
  }

  const maxPage = Math.max(0, totalPages - 1);
  const requestedPage = Math.max(0, Math.min(page, maxPage));

  let start = 0;
  for (let p = 0; p < requestedPage; p++) {
    let used = 0;
    while (used < questionRows && start < questions.length) {
      const qRows = countQuestionRows(questions[start]);
      if (used + qRows > questionRows) break;
      used += qRows;
      start++;
    }
  }

  let end = start;
  let used = 0;
  while (used < questionRows && end < questions.length) {
    const qRows = countQuestionRows(questions[end]);
    if (used + qRows > questionRows) break;
    used += qRows;
    end++;
  }

  return { start, end, maxPage };
}

function findRequestForSession(
  questions: QuestionRequest[],
  requestId: string,
  sessionId: string,
): QuestionRequest | undefined {
  return questions.find((q) => q.id === requestId && q.sessionID === sessionId);
}

function getOrCreateSelections(
  requestId: string,
  threadId: string,
): Map<number, string[]> {
  const key = `${requestId}:${threadId}`;
  let selections = pendingAnswers.get(key);
  if (!selections) {
    selections = new Map();
    pendingAnswers.set(key, selections);
  }
  return selections;
}

export function buildQuestionText(
  questions: QuestionItem[],
  selections: Map<number, string[]>,
  start: number = 0,
  end?: number,
): string {
  const slice = end !== undefined ? questions.slice(start, end) : questions.slice(start);
  const parts = slice.map((q, i) => {
    const idx = start + i;
    const labels = selections.get(idx) ?? [];
    const isAnswered = labels.length > 0;
    const status = isAnswered ? `✅ ${labels.join(', ')}` : '⬜ Pending';
    const header = q.header ? `**${q.header}**` : '';
    const body = q.question.slice(0, 200);
    return `**Q${idx + 1}:** ${header} (${status})\n${body}`;
  });
  return `⏸️ **Waiting for OpenCode input**\n\n${parts.join('\n\n')}`;
}

function buildQuestionTextAnswered(
  questions: QuestionItem[],
  selections: Map<number, string[]>,
): string {
  const parts = questions.map((q, i) => {
    const labels = selections.get(i) ?? [];
    return `**Q${i + 1}:** ${q.header || q.question.slice(0, 100)}\n✅ ${labels.join(', ')}`;
  });
  return `**⏸️ Questions answered**\n\n${parts.join('\n\n')}`;
}

export function buildQuestionComponents(
  threadId: string,
  request: QuestionRequest,
  selections: Map<number, string[]>,
  showSubmit: boolean,
  page: number = 0,
): ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[] {
  const rows: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[] = [];
  const maxRows = 5;
  const questions = request.questions;
  const questionRows = maxRows - 1;
  const { start, end, maxPage } = computePageSlice(questions, page, questionRows);
  const currentPage = Math.max(0, Math.min(page, maxPage));

  for (let qIdx = start; qIdx < end && rows.length < questionRows; qIdx++) {
    const question = request.questions[qIdx];
    const selectedLabels = selections.get(qIdx) ?? [];
    const options = question.options ?? [];
    const isMulti = question.multiple === true;
    let hasCustom = question.custom !== false;
    if (!hasCustom && options.length > 25) {
      hasCustom = true;
    }

    if (options.length === 0) {
      rows.push(
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(`qcustom:${threadId}:${request.id}:${qIdx}`)
            .setLabel('✏️ Type answer')
            .setStyle(ButtonStyle.Secondary),
        ),
      );
    } else {
      const totalSlots = options.length + (hasCustom ? 1 : 0);
      const useSelect = isMulti || options.length > 5 || totalSlots > 5;

      if (useSelect) {
        const selectMenu = new StringSelectMenuBuilder()
          .setCustomId(`qselect:${threadId}:${request.id}:${qIdx}`)
          .setPlaceholder(
            selectedLabels.length > 0
              ? `Selected: ${selectedLabels.join(', ').slice(0, 100)}`
              : `Choose option(s) for Q${qIdx + 1}`,
          )
          .setMinValues(1)
          .setMaxValues(Math.min(isMulti ? options.length : 1, 25))
          .addOptions(
            options.slice(0, 25).map((opt, oIdx) => {
              const optBuilder = new StringSelectMenuOptionBuilder()
                .setLabel(opt.label.slice(0, 100))
                .setValue(String(oIdx))
                .setDefault(selectedLabels.includes(opt.label));
              if (opt.description) {
                optBuilder.setDescription(opt.description.slice(0, 100));
              }
              return optBuilder;
            }),
          );

        rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu));
      } else {
        const buttons = options.map((opt, oIdx) => {
          const isSelected = selectedLabels.includes(opt.label);
          const customId = isMulti
            ? `qtoggle:${threadId}:${request.id}:${qIdx}:${oIdx}`
            : `qanswer:${threadId}:${request.id}:${qIdx}:${oIdx}`;

          return new ButtonBuilder()
            .setCustomId(customId)
            .setLabel(opt.label.slice(0, 80))
            .setStyle(
              isSelected
                ? isMulti
                  ? ButtonStyle.Success
                  : ButtonStyle.Primary
                : ButtonStyle.Secondary,
            );
        });

        if (hasCustom) {
          buttons.push(
            new ButtonBuilder()
              .setCustomId(`qcustom:${threadId}:${request.id}:${qIdx}`)
              .setLabel('✏️ Custom')
              .setStyle(ButtonStyle.Secondary),
          );
        }

        rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons));
      }

      if (useSelect && hasCustom && rows.length < maxRows) {
        rows.push(
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
              .setCustomId(`qcustom:${threadId}:${request.id}:${qIdx}`)
              .setLabel('✏️ Custom')
              .setStyle(ButtonStyle.Secondary),
          ),
        );
      }
    }
  }

  if (rows.length >= maxRows) return rows;

  const hasMulti = request.questions.some((q) => q.multiple);
  const allAnswered = request.questions.every(
    (_, i) => (selections.get(i) ?? []).length > 0,
  );

  const bottomButtons: ButtonBuilder[] = [];

  if (hasMulti && showSubmit) {
    bottomButtons.push(
      new ButtonBuilder()
        .setCustomId(`qsubmit:${threadId}:${request.id}`)
        .setLabel('Submit Answers')
        .setStyle(ButtonStyle.Success)
        .setDisabled(!allAnswered),
    );
  }

  if (maxPage > 0) {
    if (currentPage > 0) {
      bottomButtons.push(
        new ButtonBuilder()
          .setCustomId(`qpage:${threadId}:${request.id}:${currentPage - 1}`)
          .setLabel('◀ Prev')
          .setStyle(ButtonStyle.Secondary),
      );
    }
    bottomButtons.push(
      new ButtonBuilder()
        .setCustomId(`qpagelabel:${threadId}:${request.id}`)
        .setLabel(`Page ${currentPage + 1}/${maxPage + 1}`)
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(true),
    );
    if (currentPage < maxPage) {
      bottomButtons.push(
        new ButtonBuilder()
          .setCustomId(`qpage:${threadId}:${request.id}:${currentPage + 1}`)
          .setLabel('Next ▶')
          .setStyle(ButtonStyle.Secondary),
      );
    }
  }

  bottomButtons.push(
    new ButtonBuilder()
      .setCustomId(`qreject:${threadId}:${request.id}`)
      .setLabel('Reject')
      .setStyle(ButtonStyle.Danger),
  );

  rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(...bottomButtons));

  return rows;
}

function buildAnsweredComponents(
  threadId: string,
  requestId: string,
): ActionRowBuilder<ButtonBuilder>[] {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`qreject:${threadId}:${requestId}`)
        .setLabel('Reject')
        .setStyle(ButtonStyle.Danger)
        .setDisabled(true),
    ),
  ];
}

export async function handleButton(interaction: ButtonInteraction) {
  const customId = interaction.customId;

  if (customId.startsWith('qanswer:')) {
    const [, threadId, requestId, questionIndexRaw, optionIndexRaw] = customId.split(':');
    await handleQuestionAnswer(interaction, threadId, requestId, questionIndexRaw, optionIndexRaw);
    return;
  }

  if (customId.startsWith('qtoggle:')) {
    const [, threadId, requestId, questionIndexRaw, optionIndexRaw] = customId.split(':');
    await handleQuestionToggle(interaction, threadId, requestId, questionIndexRaw, optionIndexRaw);
    return;
  }

  if (customId.startsWith('qsubmit:')) {
    const [, threadId, requestId] = customId.split(':');
    await handleQuestionSubmit(interaction, threadId, requestId);
    return;
  }

  if (customId.startsWith('qreject:')) {
    const [, threadId, requestId] = customId.split(':');
    await handleQuestionReject(interaction, threadId, requestId);
    return;
  }

  if (customId.startsWith('qcustom:')) {
    const [, threadId, requestId, questionIndexRaw] = customId.split(':');
    await handleQuestionCustomButton(interaction, threadId, requestId, questionIndexRaw);
    return;
  }

  if (customId.startsWith('qpage:')) {
    const [, threadId, requestId, pageRaw] = customId.split(':');
    await handleQuestionPage(interaction, threadId, requestId, pageRaw);
    return;
  }

  if (customId.startsWith('qpagelabel:')) {
    await interaction.deferUpdate();
    return;
  }

  const [action, threadId] = customId.split('_');

  if (!threadId) {
    await interaction.reply({
      content: '❌ Invalid button.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (action === 'interrupt') {
    await handleInterrupt(interaction, threadId);
  } else if (action === 'delete') {
    await handleWorktreeDelete(interaction, threadId);
  } else if (action === 'pr') {
    await handleWorktreePR(interaction, threadId);
  } else {
    await interaction.reply({
      content: '❌ Unknown action.',
      flags: MessageFlags.Ephemeral,
    });
  }
}

export async function handleSelectMenu(interaction: StringSelectMenuInteraction) {
  const customId = interaction.customId;

  if (customId.startsWith('qselect:')) {
    const [, threadId, requestId, questionIndexRaw] = customId.split(':');
    const questionIndex = Number(questionIndexRaw);

    if (!threadId || !requestId || !Number.isInteger(questionIndex)) {
      await interaction.reply({
        content: '❌ Invalid question selection.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const session = sessionManager.getSessionForThread(threadId);
    if (!session) {
      await interaction.reply({
        content: '⚠️ Session not found.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.deferUpdate();

    try {
      const questions = (await sessionManager.listQuestions(session.port)) as QuestionRequest[];
      const request = findRequestForSession(questions, requestId, session.sessionId);

      if (!request) {
        await interaction.editReply({
          content: '⚠️ Pending question not found or belongs to another session.',
        });
        return;
      }

      const question = request.questions[questionIndex];
      if (!question) {
        await interaction.editReply({
          content: '⚠️ Question not found.',
        });
        return;
      }

      const selectedLabels = interaction.values
        .map((v) => Number(v))
        .filter((idx) => Number.isInteger(idx) && question.options?.[idx])
        .map((idx) => question.options![idx].label);

      const selections = getOrCreateSelections(requestId, threadId);
      selections.set(questionIndex, selectedLabels);

      const allAnswered = request.questions.every(
        (_, i) => (selections.get(i) ?? []).length > 0,
      );

      if (allAnswered) {
        await submitAllAnswers(interaction, session.port, request, selections, `${requestId}:${threadId}`, threadId);
      } else {
        const hasMulti = request.questions.some((q) => q.multiple);
        const showSubmit = hasMulti || request.questions.length > 1;
        const page = pendingPage.get(`${requestId}:${threadId}`) ?? 0;
        const { start: ts, end: te } = computePageSlice(request.questions, page, 4);
        const text = buildQuestionText(request.questions, selections, ts, te);
        const components = buildQuestionComponents(threadId, request, selections, showSubmit, page);

        const safeComponents = components.slice(0, 5);

        await interaction.editReply({ content: text, components: safeComponents });
        await interaction.followUp({
          content: `✅ Selected: ${selectedLabels.join(', ') || '(none)'}`,
          flags: MessageFlags.Ephemeral,
        });
      }
    } catch (error) {
      await interaction.editReply({
        content: `❌ Failed to process selection: ${(error as Error).message}`,
      });
    }
  }
}

export async function handleModalSubmit(interaction: ModalSubmitInteraction) {
  const customId = interaction.customId;

  if (customId.startsWith('qcustomModal:')) {
    const [, threadId, requestId, questionIndexRaw] = customId.split(':');
    const questionIndex = Number(questionIndexRaw);

    if (!threadId || !requestId || !Number.isInteger(questionIndex)) {
      await interaction.reply({
        content: '❌ Invalid custom answer.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const session = sessionManager.getSessionForThread(threadId);
    if (!session) {
      await interaction.reply({
        content: '⚠️ Session not found.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.deferUpdate();

    try {
      const questions = (await sessionManager.listQuestions(session.port)) as QuestionRequest[];
      const request = findRequestForSession(questions, requestId, session.sessionId);

      if (!request) {
        await interaction.editReply({
          content: '⚠️ Pending question not found or belongs to another session.',
        });
        return;
      }

      const answer = interaction.fields.getTextInputValue('answer');

      const selections = getOrCreateSelections(requestId, threadId);
      selections.set(questionIndex, [answer]);

      const allAnswered = request.questions.every(
        (_, i) => (selections.get(i) ?? []).length > 0,
      );

      if (allAnswered) {
        await submitAllAnswers(interaction, session.port, request, selections, `${requestId}:${threadId}`, threadId);
      } else {
        const page = pendingPage.get(`${requestId}:${threadId}`) ?? 0;
        const { start: ts, end: te } = computePageSlice(request.questions, page, 4);
        const text = buildQuestionText(request.questions, selections, ts, te);
        const components = buildQuestionComponents(threadId, request, selections, false, page);
        await interaction.editReply({ content: text, components: components.slice(0, 5) });
        await interaction.followUp({
          content: `✅ Q${questionIndex + 1} answered: ${answer.slice(0, 100)}`,
          flags: MessageFlags.Ephemeral,
        });
      }
    } catch (error) {
      await interaction.editReply({
        content: `❌ Failed to process custom answer: ${(error as Error).message}`,
      });
    }
  }
}

async function submitAllAnswers(
  interaction: ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction,
  port: number,
  request: QuestionRequest,
  selections: Map<number, string[]>,
  answerKey: string,
  threadId: string,
) {
  const answers = request.questions.map((_, i) => selections.get(i) ?? []);
  await sessionManager.replyQuestion(port, request.id, answers);
  clearPendingAnswers(answerKey);

  const answeredText = buildQuestionTextAnswered(request.questions, selections);
  const answeredComponents = buildAnsweredComponents(threadId, request.id);
  await interaction.editReply({ content: answeredText, components: answeredComponents });
  await interaction.followUp({
    content: '✅ All questions answered.',
    flags: MessageFlags.Ephemeral,
  });
}

async function handleQuestionCustomButton(
  interaction: ButtonInteraction,
  threadId: string | undefined,
  requestId: string | undefined,
  questionIndexRaw: string | undefined,
) {
  const questionIndex = Number(questionIndexRaw);

  if (!threadId || !requestId || !Number.isInteger(questionIndex)) {
    await interaction.reply({
      content: '❌ Invalid custom answer request.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const session = sessionManager.getSessionForThread(threadId);
  if (!session) {
    await interaction.reply({
      content: '⚠️ Session not found.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const modal = new ModalBuilder()
    .setCustomId(`qcustomModal:${threadId}:${requestId}:${questionIndex}`)
    .setTitle('Custom answer')
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('answer')
          .setLabel('Your answer')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('Type your answer...')
          .setRequired(true)
          .setMaxLength(1500),
      ),
    );

  await interaction.showModal(modal);
}

async function handleQuestionAnswer(
  interaction: ButtonInteraction,
  threadId: string | undefined,
  requestId: string | undefined,
  questionIndexRaw: string | undefined,
  optionIndexRaw: string | undefined,
) {
  const questionIndex = Number(questionIndexRaw);
  const optionIndex = Number(optionIndexRaw);

  if (!threadId || !requestId || !Number.isInteger(questionIndex) || !Number.isInteger(optionIndex)) {
    await interaction.reply({
      content: '❌ Invalid question response.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const session = sessionManager.getSessionForThread(threadId);
  if (!session) {
    await interaction.reply({
      content: '⚠️ Session not found.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferUpdate();

  try {
    const questions = (await sessionManager.listQuestions(session.port)) as QuestionRequest[];
    const request = findRequestForSession(questions, requestId, session.sessionId);

    if (!request) {
      await interaction.editReply({
        content: '⚠️ Pending question not found or belongs to another session.',
      });
      return;
    }

    const question = request.questions[questionIndex];
    const option = question?.options?.[optionIndex];

    if (!option?.label) {
      await interaction.editReply({
        content: '⚠️ Option not found. It may have already been answered.',
      });
      return;
    }

    const selections = getOrCreateSelections(requestId, threadId);
    selections.set(questionIndex, [option.label]);

    const allAnswered = request.questions.every((_, i) => (selections.get(i) ?? []).length > 0);

    if (allAnswered) {
      await submitAllAnswers(interaction, session.port, request, selections, `${requestId}:${threadId}`, threadId);
    } else {
      const page = pendingPage.get(`${requestId}:${threadId}`) ?? 0;
      const { start: ts, end: te } = computePageSlice(request.questions, page, 4);
      const text = buildQuestionText(request.questions, selections, ts, te);
      const components = buildQuestionComponents(threadId, request, selections, false, page);
      await interaction.editReply({ content: text, components: components.slice(0, 5) });
      await interaction.followUp({
        content: `✅ Q${questionIndex + 1} answered: ${option.label}`,
        flags: MessageFlags.Ephemeral,
      });
    }
  } catch (error) {
    await interaction.editReply({
      content: `❌ Failed to answer question: ${(error as Error).message}`,
    });
  }
}

async function handleQuestionToggle(
  interaction: ButtonInteraction,
  threadId: string | undefined,
  requestId: string | undefined,
  questionIndexRaw: string | undefined,
  optionIndexRaw: string | undefined,
) {
  const questionIndex = Number(questionIndexRaw);
  const optionIndex = Number(optionIndexRaw);

  if (!threadId || !requestId || !Number.isInteger(questionIndex) || !Number.isInteger(optionIndex)) {
    await interaction.reply({
      content: '❌ Invalid toggle.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const session = sessionManager.getSessionForThread(threadId);
  if (!session) {
    await interaction.reply({
      content: '⚠️ Session not found.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferUpdate();

  try {
    const questions = (await sessionManager.listQuestions(session.port)) as QuestionRequest[];
    const request = findRequestForSession(questions, requestId, session.sessionId);

    if (!request) {
      await interaction.editReply({
        content: '⚠️ Pending question not found or belongs to another session.',
      });
      return;
    }

    const option = request.questions[questionIndex]?.options?.[optionIndex];
    if (!option?.label) {
      await interaction.editReply({
        content: '⚠️ Option not found.',
      });
      return;
    }

    const selections = getOrCreateSelections(requestId, threadId);

    const current = selections.get(questionIndex) ?? [];
    if (current.includes(option.label)) {
      selections.set(questionIndex, current.filter((l) => l !== option.label));
    } else {
      selections.set(questionIndex, [...current, option.label]);
    }

    const page = pendingPage.get(`${requestId}:${threadId}`) ?? 0;
    const { start: ts, end: te } = computePageSlice(request.questions, page, 4);
    const text = buildQuestionText(request.questions, selections, ts, te);
    const components = buildQuestionComponents(threadId, request, selections, true, page);
    await interaction.editReply({ content: text, components: components.slice(0, 5) });
    await interaction.followUp({
      content: `Toggled: ${option.label}`,
      flags: MessageFlags.Ephemeral,
    });
  } catch (error) {
    await interaction.editReply({
      content: `❌ Failed to toggle: ${(error as Error).message}`,
    });
  }
}

async function handleQuestionSubmit(
  interaction: ButtonInteraction,
  threadId: string | undefined,
  requestId: string | undefined,
) {
  if (!threadId || !requestId) {
    await interaction.reply({
      content: '❌ Invalid submit.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const session = sessionManager.getSessionForThread(threadId);
  if (!session) {
    await interaction.reply({
      content: '⚠️ Session not found.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferUpdate();

  try {
    const questions = (await sessionManager.listQuestions(session.port)) as QuestionRequest[];
    const request = findRequestForSession(questions, requestId, session.sessionId);

    if (!request) {
      await interaction.editReply({
        content: '⚠️ Pending question not found or belongs to another session.',
      });
      return;
    }

    const selections = getOrCreateSelections(requestId, threadId);

    const allAnswered = request.questions.every(
      (_, i) => (selections.get(i) ?? []).length > 0,
    );

    if (!allAnswered) {
      await interaction.editReply({
        content: '❌ Not all questions have an answer yet. Please answer all questions before submitting.',
      });
      return;
    }

    await submitAllAnswers(interaction, session.port, request, selections, `${requestId}:${threadId}`, threadId);
  } catch (error) {
    await interaction.editReply({
      content: `❌ Failed to submit: ${(error as Error).message}`,
    });
  }
}

async function handleQuestionReject(
  interaction: ButtonInteraction,
  threadId: string | undefined,
  requestId: string | undefined,
) {
  if (!threadId || !requestId) {
    await interaction.reply({
      content: '❌ Invalid question rejection.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const session = sessionManager.getSessionForThread(threadId);
  if (!session) {
    await interaction.reply({
      content: '⚠️ Session not found.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferUpdate();

  try {
    const questions = (await sessionManager.listQuestions(session.port)) as QuestionRequest[];
    const request = findRequestForSession(questions, requestId, session.sessionId);

    if (!request) {
      await interaction.editReply({
        content: '⚠️ Pending question not found or belongs to another session.',
      });
      return;
    }

    await sessionManager.rejectQuestion(session.port, requestId);
    const answerKey = `${requestId}:${threadId}`;
    clearPendingAnswers(answerKey);

    await interaction.editReply({
      content: '🚫 Question rejected.',
      components: buildAnsweredComponents(threadId, requestId),
    });
    await interaction.followUp({
      content: '🚫 Question rejected.',
      flags: MessageFlags.Ephemeral,
    });
  } catch (error) {
    await interaction.editReply({
      content: `❌ Failed to reject question: ${(error as Error).message}`,
    });
  }
}

async function handleQuestionPage(
  interaction: ButtonInteraction,
  threadId: string | undefined,
  requestId: string | undefined,
  pageRaw: string | undefined,
) {
  if (!threadId || !requestId || pageRaw === undefined) {
    await interaction.reply({
      content: '❌ Invalid page navigation.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const newPage = Number(pageRaw);
  if (!Number.isInteger(newPage)) {
    await interaction.reply({
      content: '❌ Invalid page number.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const session = sessionManager.getSessionForThread(threadId);
  if (!session) {
    await interaction.reply({
      content: '⚠️ Session not found.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferUpdate();

  try {
    const questions = (await sessionManager.listQuestions(session.port)) as QuestionRequest[];
    const request = findRequestForSession(questions, requestId, session.sessionId);

    if (!request) {
      await interaction.editReply({
        content: '⚠️ Pending question not found or belongs to another session.',
      });
      return;
    }

    const key = `${requestId}:${threadId}`;
    pendingPage.set(key, newPage);

    const selections = getOrCreateSelections(requestId, threadId);
    const hasMulti = request.questions.some((q) => q.multiple);
    const showSubmit = hasMulti || request.questions.length > 1;
    const { start: ts, end: te } = computePageSlice(request.questions, newPage, 4);
    const text = buildQuestionText(request.questions, selections, ts, te);
    const components = buildQuestionComponents(threadId, request, selections, showSubmit, newPage);

    await interaction.editReply({ content: text, components: components.slice(0, 5) });
  } catch (error) {
    await interaction.editReply({
      content: `❌ Failed to change page: ${(error as Error).message}`,
    });
  }
}

async function handleInterrupt(interaction: ButtonInteraction, threadId: string) {
  const session = sessionManager.getSessionForThread(threadId);

  if (!session) {
    await interaction.reply({
      content: '⚠️ Session not found.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const channel = interaction.channel;
  const parentChannelId = channel?.isThread() ? (channel as ThreadChannel).parentId! : channel?.id;
  const preferredModel = parentChannelId ? dataStore.getChannelModel(parentChannelId) : undefined;

  const port = serveManager.getPort(session.projectPath, preferredModel);

  if (!port) {
    await interaction.reply({
      content: '⚠️ Server is not running.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const success = await sessionManager.abortSession(port, session.sessionId);

  if (success) {
    await interaction.editReply({ content: '⏸️ Interrupt request sent.' });
  } else {
    await interaction.editReply({
      content: '⚠️ Failed to interrupt. Server may not be running or no active task.',
    });
  }
}

async function handleWorktreeDelete(interaction: ButtonInteraction, threadId: string) {
  const mapping = dataStore.getWorktreeMapping(threadId);
  if (!mapping) {
    await interaction.reply({ content: '⚠️ Worktree mapping not found.', flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    if (worktreeManager.worktreeExists(mapping.worktreePath)) {
      await worktreeManager.removeWorktree(mapping.worktreePath, false);
    }

    dataStore.removeWorktreeMapping(threadId);

    const channel = interaction.channel;
    if (channel?.isThread()) {
      await (channel as ThreadChannel).setArchived(true);
    }

    await interaction.editReply({ content: '✅ Worktree deleted and thread archived.' });
  } catch (error) {
    await interaction.editReply({ content: `❌ Failed to delete worktree: ${(error as Error).message}` });
  }
}

async function handleWorktreePR(interaction: ButtonInteraction, threadId: string) {
  const mapping = dataStore.getWorktreeMapping(threadId);
  if (!mapping) {
    await interaction.reply({ content: '⚠️ Worktree mapping not found.', flags: MessageFlags.Ephemeral });
    return;
  }

  const channel = interaction.channel;
  const parentChannelId = channel?.isThread() ? (channel as ThreadChannel).parentId! : channel?.id;
  const preferredModel = parentChannelId ? dataStore.getChannelModel(parentChannelId) : undefined;

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    const port = await serveManager.spawnServe(mapping.worktreePath, preferredModel);
    await serveManager.waitForReady(port, 30000, mapping.worktreePath, preferredModel);

    const sessionId = await sessionManager.ensureSessionForThread(
      threadId,
      mapping.worktreePath,
      port,
    );

    const prPrompt = `Create a pull request for the current branch. Include a clear title and description summarizing all changes.`;
    await sessionManager.sendPrompt(port, sessionId, prPrompt, preferredModel);

    await interaction.editReply({ content: '🚀 PR creation started! Check the thread for progress.' });
  } catch (error) {
    await interaction.editReply({ content: `❌ Failed to start PR creation: ${(error as Error).message}` });
  }
}
