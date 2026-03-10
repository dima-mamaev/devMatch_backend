import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { v2 as cloudinary, UploadApiResponse } from 'cloudinary';

@Injectable()
export class CloudinaryService {
  constructor(private config: ConfigService) {
    cloudinary.config({
      cloud_name: config.get<string>('CLOUDINARY_CLOUD_NAME'),
      api_key: config.get<string>('CLOUDINARY_API_KEY'),
      api_secret: config.get<string>('CLOUDINARY_API_SECRET'),
    });
  }

  async uploadFile(publicId: string, data: Buffer, folder = 'devmatch/thumbnails'): Promise<string> {

    try {
      const result = await new Promise<UploadApiResponse>((resolve, reject) => {
        cloudinary.uploader
          .upload_stream(
            {
              public_id: publicId,
              resource_type: 'image',
              folder,
            },
            (error, result) => {
              if (error) {
                reject(error);
              } else {
                resolve(result!);
              }
            },
          )
          .end(data);
      });

      return result.secure_url;
    } catch (err) {
      throw new InternalServerErrorException(err);
    }
  }
}
