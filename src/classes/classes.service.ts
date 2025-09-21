import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { CreateClassDto } from './dto/create-class.dto';
import { UpdateClassDto } from './dto/update-class.dto';
import { CreateClassTimeDto } from './dto/create-class-time.dto';
import { UpdateClassTimeDto } from './dto/update-class-time.dto';
import { InvoicesService } from 'src/billing/invoices.service';

@Injectable()
export class ClassesService {
  constructor(
    private prisma: PrismaService,
    private invoices: InvoicesService,
  ) {}

  async findAll() {
    // Cast to any to avoid type errors before running `prisma generate`
    return (this.prisma as any).class.findMany({
      include: {
        teacher: { include: { user: true } },
        students: { include: { user: true } },
        classTimes: true,
        subject: { include: { track: { include: { level: true } } } },
      },
      orderBy: { startAt: 'asc' },
    });
  }

  async findOne(id: string) {
    const klass = await (this.prisma as any).class.findUnique({
      where: { id },
      include: {
        teacher: { include: { user: true } },
        students: { include: { user: true } },
        classTimes: true,
        subject: { include: { track: { include: { level: true } } } },
      },
    });
    if (!klass) throw new NotFoundException('Class not found');

    // compute total monthly income: price per student * number of students
    // Update to consider FIXED_TOTAL
    const monthlyIncome =
      klass.pricingMode === 'FIXED_TOTAL'
        ? (klass.fixedMonthlyPriceCents ?? 0)
        : (klass.monthlyPriceCents ?? 0) * (klass.students?.length ?? 0);

    return { ...klass, totalMonthlyIncomeCents: monthlyIncome };
  }

  async create(data: CreateClassDto) {
    const teacher = await this.prisma.teacher.findUnique({
      where: { id: data.teacherId },
    });
    if (!teacher) throw new NotFoundException('Teacher not found');
    let name = data.name;
    if (data.subjectId) {
      const subject = await (this.prisma as any).subject.findUnique({
        where: { id: data.subjectId },
        include: { track: { include: { level: true } } },
      });
      if (!subject) throw new NotFoundException('Subject not found');
      if (!name) {
        name = [
          subject.track.level.name,
          subject.track.name,
          subject.name,
          data.customSuffix,
        ]
          .filter(Boolean)
          .join(' ');
      }
    }

    return (this.prisma as any).class.create({
      data: { ...data, name, subjectId: data.subjectId ?? null },
      include: {
        teacher: { include: { user: true } },
        students: { include: { user: true } },
        subject: { include: { track: { include: { level: true } } } },
      },
    });
  }

  async addStudent(classId: string, studentId: string) {
    const res = await this.prisma.class.update({
      where: { id: classId },
      data: { students: { connect: { id: studentId } } },
      include: { students: true },
    });
    await this.invoices.ensureUpcomingInvoiceForStudent(studentId);
    return res;
  }

  async removeStudent(classId: string, studentId: string) {
    const res = await this.prisma.class.update({
      where: { id: classId },
      data: { students: { disconnect: { id: studentId } } },
      include: { students: true },
    });
    await this.invoices.ensureUpcomingInvoiceForStudent(studentId);
    return res;
  }

  async addTeacher(classId: string, teacherId: string) {
    // Check class exists
    const classObj = await this.prisma.class.findUnique({
      where: { id: classId },
    });
    if (!classObj) throw new NotFoundException('Class not found');

    // Check teacher exists
    const teacher = await this.prisma.teacher.findUnique({
      where: { id: teacherId },
    });
    if (!teacher) throw new NotFoundException('Teacher not found');

    return this.prisma.class.update({
      where: { id: classId },
      data: { teacherId },
      include: {
        teacher: { include: { user: true } },
        students: { include: { user: true } },
      },
    });
  }

  async update(id: string, data: UpdateClassDto) {
    const existing = await (this.prisma as any).class.findUnique({
      where: { id },
    });
    if (!existing) throw new NotFoundException('Class not found');
    let name = data.name;
    if (data.subjectId && !name) {
      const subject = await (this.prisma as any).subject.findUnique({
        where: { id: data.subjectId },
        include: { track: { include: { level: true } } },
      });
      if (!subject) throw new NotFoundException('Subject not found');
      name = [subject.track.level.name, subject.track.name, subject.name]
        .filter(Boolean)
        .join(' ');
    }

    return (this.prisma as any).class.update({
      where: { id },
      data: { ...data, name: name ?? existing.name },
      include: {
        teacher: { include: { user: true } },
        students: { include: { user: true } },
        classTimes: true,
        subject: { include: { track: { include: { level: true } } } },
      },
    });
  }

  async remove(id: string) {
    // cascade deletes ClassTime via FK if desired (or deleteMany first)
    await this.prisma.classTime.deleteMany({ where: { classId: id } });
    return this.prisma.class.delete({ where: { id } });
  }

  // ---- Times ----
  async listTimes(classId: string) {
    await this.ensureClass(classId);
    return this.prisma.classTime.findMany({
      where: { classId },
      orderBy: [{ dayOfWeek: 'asc' }, { startMinutes: 'asc' }],
    });
  }

  async addTime(classId: string, dto: CreateClassTimeDto) {
    await this.ensureClass(classId);
    if (dto.endMinutes <= dto.startMinutes) {
      throw new NotFoundException(
        'endMinutes must be greater than startMinutes',
      );
    }
    return this.prisma.classTime.create({ data: { classId, ...dto } });
  }

  async updateTime(classId: string, timeId: string, dto: UpdateClassTimeDto) {
    await this.ensureClass(classId);
    const time = await this.prisma.classTime.findUnique({
      where: { id: timeId },
    });
    if (!time || time.classId !== classId)
      throw new NotFoundException('Time not found');

    const next = {
      dayOfWeek: dto.dayOfWeek ?? time.dayOfWeek,
      startMinutes: dto.startMinutes ?? time.startMinutes,
      endMinutes: dto.endMinutes ?? time.endMinutes,
    };
    if (next.endMinutes <= next.startMinutes) {
      throw new NotFoundException(
        'endMinutes must be greater than startMinutes',
      );
    }

    return this.prisma.classTime.update({ where: { id: timeId }, data: dto });
  }

  async removeTime(classId: string, timeId: string) {
    await this.ensureClass(classId);
    const time = await this.prisma.classTime.findUnique({
      where: { id: timeId },
    });
    if (!time || time.classId !== classId)
      throw new NotFoundException('Time not found');
    return this.prisma.classTime.delete({ where: { id: timeId } });
  }

  async updatePricing(
    classId: string,
    data: {
      pricingMode: 'PER_STUDENT' | 'FIXED_TOTAL';
      monthlyPriceCents?: number;
      fixedMonthlyPriceCents?: number;
      teacherFixedMonthlyPayCents?: number;
    },
  ) {
    await this.ensureClass(classId);

    return this.prisma.class.update({
      where: { id: classId },
      data: {
        pricingMode: data.pricingMode,
        monthlyPriceCents: data.monthlyPriceCents,
        fixedMonthlyPriceCents: data.fixedMonthlyPriceCents,
        teacherFixedMonthlyPayCents: data.teacherFixedMonthlyPayCents,
      },
    });
  }

  private async ensureClass(classId: string) {
    const klass = await this.prisma.class.findUnique({
      where: { id: classId },
    });
    if (!klass) throw new NotFoundException('Class not found');
  }

  // -------- Academic hierarchy --------
  async createLevel(data: { name: string }) {
    return (this.prisma as any).level.create({ data });
  }

  async listLevels() {
    return (this.prisma as any).level.findMany({
      include: {
        tracks: { include: { subjects: true } },
      },
      orderBy: { name: 'asc' },
    });
  }

  async createTrack(data: { levelId: string; name: string }) {
    // ensure level exists
    await this.ensureLevel(data.levelId);
    return (this.prisma as any).track.create({ data });
  }

  async createSubject(data: { trackId: string; name: string }) {
    await this.ensureTrack(data.trackId);
    return (this.prisma as any).subject.create({ data });
  }

  async deleteSubject(id: string) {
    // disallow if any classes reference it
    const classCount = await (this.prisma as any).class.count({
      where: { subjectId: id },
    });
    if (classCount > 0)
      throw new NotFoundException(
        'Cannot delete subject with existing classes',
      );
    return (this.prisma as any).subject.delete({ where: { id } });
  }

  async deleteTrack(id: string) {
    // disallow if any subject under it has classes
    const classCount = await (this.prisma as any).class.count({
      where: { subject: { trackId: id } },
    });
    if (classCount > 0)
      throw new NotFoundException(
        'Cannot delete track with classes under its subjects',
      );
    return (this.prisma as any).track.delete({ where: { id } });
  }

  async deleteLevel(id: string) {
    // disallow if any class references a subject under this level
    const classCount = await (this.prisma as any).class.count({
      where: { subject: { track: { levelId: id } } },
    });
    if (classCount > 0)
      throw new NotFoundException('Cannot delete level with classes under it');
    return (this.prisma as any).level.delete({ where: { id } });
  }

  private async ensureLevel(id: string) {
    const level = await (this.prisma as any).level.findUnique({
      where: { id },
    });
    if (!level) throw new NotFoundException('Level not found');
  }

  private async ensureTrack(id: string) {
    const track = await (this.prisma as any).track.findUnique({
      where: { id },
    });
    if (!track) throw new NotFoundException('Track not found');
  }
}
