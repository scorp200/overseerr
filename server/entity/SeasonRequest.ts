import { MediaRequestStatus } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import {
  AfterUpdate,
  Column,
  CreateDateColumn,
  Entity,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { MediaRequest } from './MediaRequest';

@Entity()
class SeasonRequest {
  @PrimaryGeneratedColumn()
  public id: number;

  @Column()
  public seasonNumber: number;

  @Column({ type: 'int', default: MediaRequestStatus.PENDING })
  public status: MediaRequestStatus;

  @ManyToOne(() => MediaRequest, (request) => request.seasons, {
    onDelete: 'CASCADE',
  })
  public request: MediaRequest;

  @CreateDateColumn()
  public createdAt: Date;

  @UpdateDateColumn()
  public updatedAt: Date;

  constructor(init?: Partial<SeasonRequest>) {
    Object.assign(this, init);
  }

  @AfterUpdate()
  public async handleRemoveParent(): Promise<void> {
    const mediaRequestRepository = getRepository(MediaRequest);
    const requestToBeDeleted = await mediaRequestRepository.findOneOrFail({
      where: { id: this.request.id },
    });

    const allSeasonsAreCompleted = requestToBeDeleted.seasons.filter(
      (season) => {
        return season.status === MediaRequestStatus.COMPLETED;
      }
    );

    if (requestToBeDeleted.seasons.length === allSeasonsAreCompleted.length) {
      await mediaRequestRepository.update(this.request.id, {
        status: MediaRequestStatus.COMPLETED,
      });
    }
  }
}

export default SeasonRequest;
