import { BullModule } from '@nestjs/bullmq';
import { Module, forwardRef } from '@nestjs/common';
import { ConverterQueueProcessor } from './converter-queue.processor';
import { ConverterQueueService } from './converter-queue.service';
import { MediaModule } from '../media/media.module';

@Module({
  imports: [
    BullModule.registerQueue({
      name: 'ConverterInputQueue',
    }),
    BullModule.registerQueue({
      name: 'ConverterOutputQueue',
    }),
    forwardRef(() => MediaModule),
  ],
  providers: [
    ConverterQueueProcessor,
    ConverterQueueService,
  ],
  exports: [ConverterQueueService],
})
export class QueuesModule {}
