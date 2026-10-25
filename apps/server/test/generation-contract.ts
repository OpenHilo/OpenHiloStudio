import type { AiTaskExecutor } from '@openhilo/ai-contracts';
import type { GenerationPort } from '@openhilo/server';
import { GenerationSession, type GenerationServices } from '@openhilo/platform-services/generation-session';
import { createFileSessionStorage } from '@openhilo/platform-services/generation-storage';
import { createGenerationService } from '@openhilo/platform-services/generation-service';
declare const executor: AiTaskExecutor;
declare const services: GenerationServices;
const service = createGenerationService({
  storage: createFileSessionStorage('/explicit/sessions'),
  create(input) {
    return GenerationSession.create({ sessionDir: '/explicit/sessions/example', workspace: input.workspace ?? '/explicit/workspace', publicationDir: '/explicit/intents',
      maxClarificationRounds: 2, maxFeedbackRounds: 3, services, aiExecutor: executor }, 'example');
  },
  inspect: saved => GenerationSession.fromJSON(saved),
  restore(saved) { const session = GenerationSession.fromJSON(saved); session.bindServices(services); session.bindAiExecutor(executor); return session; },
});
const port: GenerationPort = service;
void port;
void service.close;
