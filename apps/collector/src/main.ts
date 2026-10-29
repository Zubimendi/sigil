import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { CollectorModule } from './collector.module';

async function bootstrap() {
  const app = await NestFactory.create(CollectorModule);
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: false,
    }),
  );
  app.enableCors();
  await app.listen(process.env.PORT || 3000);
}

bootstrap();
