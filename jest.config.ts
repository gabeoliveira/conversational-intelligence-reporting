import type { Config } from 'jest';

const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/services/', '<rootDir>/packages/'],
  testMatch: ['**/__tests__/**/*.test.ts'],
  moduleNameMapper: {
    '^@cirl/shared$': '<rootDir>/packages/shared/src',
  },
};

export default config;
