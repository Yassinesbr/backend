import { IsNotEmpty, IsString } from 'class-validator';

export class CreateSubjectDto {
  @IsNotEmpty()
  @IsString()
  trackId: string; // references Track.id

  @IsNotEmpty()
  @IsString()
  name: string;
}
