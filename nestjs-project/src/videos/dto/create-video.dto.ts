import { IsNumber, IsPositive, IsString, Max } from 'class-validator';

const MAX_FILE_SIZE_BYTES = 10737418240;

export class CreateVideoDto {
  @IsString()
  fileName: string;

  @IsNumber()
  @IsPositive()
  @Max(MAX_FILE_SIZE_BYTES)
  fileSizeBytes: number;

  @IsString()
  mimeType: string;
}
