// ============================================================
// 项目数据模型
// ============================================================

/** 团队成员 */
export interface TeamMember {
  name: string;
  studentId?: string;
  major?: string;
  grade?: string;
  role?: string;
  phone?: string;
  email?: string;
}

/** 指导教师 */
export interface Advisor {
  name: string;
  title?: string;
  direction?: string;
  phone?: string;
  unit?: string;
}

/** 已有成果 */
export interface Achievement {
  type: "paper" | "patent" | "software_copyright" | "prize" | "other";
  title: string;
  description: string;
  date?: string;
  filePath?: string;
}

/** 项目定义 */
export interface ProjectDef {
  id: string;
  name: string;
  competition: string;
  track?: string;
  description: string;
  team: TeamMember[];
  advisor?: Advisor;
  achievements: Achievement[];
  templateId: string;
  workflowId: string;
  variables: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
  status: ProjectStatus;
}

/** 项目状态 */
export type ProjectStatus =
  | "draft"
  | "in_progress"
  | "reviewed"
  | "completed"
  | "archived";

/** 项目简档（列表用） */
export interface ProjectMeta {
  id: string;
  name: string;
  competition: string;
  status: ProjectStatus;
  lastGenerated?: Date;
  templateName: string;
  teamSize: number;
}

/** 项目存储查询 */
export interface ProjectQuery {
  competition?: string;
  status?: ProjectStatus;
  keyword?: string;
  sortBy?: "createdAt" | "updatedAt" | "name";
  sortOrder?: "asc" | "desc";
  limit?: number;
  offset?: number;
}
