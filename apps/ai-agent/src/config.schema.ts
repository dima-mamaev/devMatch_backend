import * as Joi from 'joi';

const PARAMS = {
  AI_AGENT_PORT: Joi.number().default(4001),

  POSTGRES_HOST: Joi.string().default('localhost').required(),
  POSTGRES_PORT: Joi.number().default(5432).required(),
  POSTGRES_DB: Joi.string().required(),
  POSTGRES_USER: Joi.string().required(),
  POSTGRES_PASSWORD: Joi.string().required(),

  REDIS_HOST: Joi.string().default('localhost').required(),
  REDIS_PORT: Joi.number().default(6379),

  OPENAI_API_KEY: Joi.string().required(),
};

export const configSchema = Joi.object<typeof PARAMS>(PARAMS);
