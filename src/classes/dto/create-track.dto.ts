import { IsNotEmpty, IsString } from 'class-validator';

export class CreateTrackDto {
  @IsNotEmpty()
  @IsString()
  levelId: string; // references Level.id

  @IsNotEmpty()
  @IsString()
  name: string;
}
