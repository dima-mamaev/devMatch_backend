import { Module } from '@nestjs/common';
import { CustomUploadScalar } from './scalars/upload.scalar';

@Module({
  providers: [CustomUploadScalar],
})
export class CustomUploadModule {}
