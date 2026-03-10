import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { GenerateThumbnailInputData } from '../../../types/types';
import { ThumbnailGeneratorService } from './thumbnail-generator.service';
import { CloudinaryService } from './cloudinary.service';

@Processor('GeneratorInputQueue', { concurrency: 1 })
export class ThumbnailGeneratorProcessor extends WorkerHost {
  constructor(
    private readonly thumbnailGeneratorService: ThumbnailGeneratorService,
    private readonly cloudinaryService: CloudinaryService,
  ) {
    super();
  }

  process({ name, data }: Job<GenerateThumbnailInputData>) {
    switch (name) {
      case 'GenerateThumbnailInput':
        return this.generateThumbnail(data);
      default:
        throw new Error(`Unknown job name: ${name}`);
    }
  }

  async generateThumbnail(data: GenerateThumbnailInputData) {
    const { videoPath, developerId, videoMediaId } = data;

    try {
      const buffer = await this.thumbnailGeneratorService.generateThumbnailFromVideo(videoPath);
      const publicId = `${developerId}_${Date.now()}`;
      const url = await this.cloudinaryService.uploadFile(publicId, buffer);
      await this.thumbnailGeneratorService.enqueueGenerateThumbnailOutput({
        path: url,
        developerId,
        videoMediaId,
      });
    } catch (err) {
      await this.thumbnailGeneratorService.enqueueGenerateThumbnailFailed({
        path: '',
        developerId,
        videoMediaId,
      });
    }
  }
}
