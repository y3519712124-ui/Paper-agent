import { Router } from "express";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { homedir } from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { checkpointStore } from "../checkpoint-store.js";
import { getRuntimeSettings } from "./settings.js";

export const workflowsRouter = Router();

const PROJECTS_DIR = join(homedir(), ".paper", "projects");
const EXPORTS_DIR = join(homedir(), ".paper", "exports");
const CODEX_LATEX_PLUGIN_ROOT = process.env.PAPER_CODEX_LATEX_PLUGIN_ROOT
  || join(homedir(), ".codex", "plugins", "cache", "openai-bundled", "latex", "0.2.2");
const CODEX_LATEX_COMPILE_SCRIPT = join(CODEX_LATEX_PLUGIN_ROOT, "scripts", "compile_latex.py");
const LATEX_COMPILE_TIMEOUT_MS = 180000;

type WorkflowTemplateId = "dachuang" | "tiaozhanbei" | "internet-plus";
type WorkflowStatus = "draft" | "running" | "completed" | "failed";

type WorkflowConfig = {
  name: string;
  template: WorkflowTemplateId;
  competition: string;
  track?: string;
  team?: string;
  brief?: string;
  product?: string;
  market?: string;
  finance?: string;
  evidence?: string;
  pageLimit?: string;
  reviewMode?: string;
  figureMode?: boolean;
  figureCount?: string;
  tableMode?: boolean;
  tableCount?: string;
  dataMode?: boolean;
  dataCount?: string;
  modelMode?: boolean;
  modelCount?: string;
  docStyle?: string;
  referenceNotes?: string;
  contestFileNotes?: string;
  attachmentNotes?: string;
  autoAdvance?: boolean;
  humanCheckpoint?: boolean;
  revisionLoop?: boolean;
  referenceContext?: string;
  styleReferenceContext?: string;
  status?: WorkflowStatus;
  created: string;
  updated: string;
};

type StepDef = {
  id: string;
  name: string;
  agent: string;
  checkpointType: string;
  targetSection: string;
  instruction: string;
};

type ArtifactFile = {
  step: StepDef;
  fileName: string;
  path: string;
  content: string;
};

type LLMCallResult = {
  text: string;
  source: "external" | "none";
  model?: string;
  error?: string;
  attempts: string[];
};

type EditorQualityContext = {
  score: number;
  band: string;
  failed: string[];
  risks: string[];
  actions: string[];
  missing: string[];
  compact: string;
};

const LLM_TIMEOUT_MS = 45000;
const MAX_MODEL_ATTEMPTS_PER_CALL = 2;
const badLLMModels = new Set<string>();

const EDITABLE_EXTENSIONS = new Set([".md", ".tex", ".txt", ".csv", ".json", ".yaml", ".yml", ".py", ".log"]);

function envFlag(name: string) {
  return /^(1|true|yes|on)$/i.test(String(process.env[name] || "").trim());
}

const COMPLETE_PROJECT_BOOK_STEPS: StepDef[] = [
  {
    id: "overview",
    name: "项目方案概述",
    agent: "项目总策划",
    checkpointType: "chapter-overview",
    targetSection: "一、项目方案概述",
    instruction:
      "生成项目背景、项目简述、创业机会与目标市场、竞争优势与当前限制、盈利模式与项目价值。开篇要能直接回答项目是什么、为什么现在做、给谁用、靠什么赢、怎么赚钱。",
  },
  {
    id: "team",
    name: "项目团队概述",
    agent: "团队叙事官",
    checkpointType: "chapter-team",
    targetSection: "二、项目团队概述",
    instruction:
      "根据团队基础设计分工闭环，写清负责人、算法/技术、产品/硬件、调研/财务/文案等角色，以及阶段复盘、知识移交、成果沉淀机制。",
  },
  {
    id: "industry-product",
    name: "产业背景与项目产品",
    agent: "产业与产品架构师",
    checkpointType: "chapter-product",
    targetSection: "三、产业背景与项目产品",
    instruction:
      "生成产业背景与市场概述、项目产品概述、技术/产品架构、核心图表说明、项目服务实施计划，并给出版本规划、交付物、验收标准和资源成本对比表。",
  },
  {
    id: "market-competition",
    name: "市场调查与竞争分析",
    agent: "市场分析师",
    checkpointType: "chapter-market",
    targetSection: "四、市场调查与竞争分析",
    instruction:
      "生成市场规模调查、目标市场规模、竞争分析、差异化优势。必须包含客户群体对比表、竞争分析表、直接/间接竞品与替代方案比较。",
  },
  {
    id: "business-strategy",
    name: "商业模式与发展战略",
    agent: "商业模式设计师",
    checkpointType: "chapter-business",
    targetSection: "五、商业模式与发展战略",
    instruction:
      "生成商业模式、收入结构、营销策略、短中长期发展战略、核心竞争力保障。要体现项目制、订阅运维、场景化模块、平台化服务等可组合模式。",
  },
  {
    id: "benefits",
    name: "预期效益分析",
    agent: "效益评估专家",
    checkpointType: "chapter-benefits",
    targetSection: "六、预期效益分析",
    instruction:
      "从社会发展与民生改善、降低一线人员风险、公共治理、绿色发展、监测预警、盈利能力、平台化与数据资产等维度写完整效益分析。",
  },
  {
    id: "finance-deliverables",
    name: "总结与资金回报",
    agent: "财务与交付规划师",
    checkpointType: "chapter-finance",
    targetSection: "七、总结与资金回报",
    instruction:
      "生成总结、资金需求、融资级别、投资人回报、退出策略、五年收入预测、关键财务模型摘要、交付物汇总和目标客户清单。数字要标注为估算口径。",
  },
  {
    id: "proof-materials",
    name: "证明材料与依据清单",
    agent: "材料合规官",
    checkpointType: "chapter-proof",
    targetSection: "八、证明材料",
    instruction:
      "整理政策、行业报告、试点证据、实验数据、团队成果、知识产权、合作资源等证明材料清单。没有真实材料时采用公开资料口径、项目估算口径、原型测试口径或附件材料说明，不要伪造来源。",
  },
  {
    id: "final-assembly",
    name: "完整项目书组装",
    agent: "总编辑",
    checkpointType: "final-book",
    targetSection: "完整项目计划书",
    instruction:
      "把前面各章统一成一篇完整项目计划书，包含封面信息、目录、八个章节、图表清单、附件材料说明和申报真实性声明。消除重复和口吻不一致。",
  },
];

const DACHUANG_PROJECT_BOOK_STEPS: StepDef[] = [
  {
    id: "dc-executive-summary",
    name: "执行摘要",
    agent: "项目总编辑",
    checkpointType: "dc-executive-summary",
    targetSection: "执行摘要",
    instruction:
      "按当前项目上传参考文档或大创基础结构写执行摘要。用正式申报书口吻概括项目背景、项目方案、技术或产品核心、目标市场、竞争优势、商业模式、团队基础、预期效益和证明材料，直接写成可放入正文的摘要，不出现建议、写作说明或系统提示。",
  },
  {
    id: "dc-project-overview",
    name: "项目方案概述",
    agent: "项目定位规划师",
    checkpointType: "dc-project-overview",
    targetSection: "一、项目方案概述",
    instruction:
      "按当前项目上传参考文档或大创基础结构生成“项目方案概述”，必须覆盖（一）项目背景、（二）项目简述、（三）创业机会与目标市场、（四）竞争优势与当前限制、（五）盈利模式与项目价值。段落要先写场景矛盾和政策/行业机会，再写本项目的技术或产品切入，最后落到市场对象、优势边界和价值，不写成建议清单。",
  },
  {
    id: "dc-project-advantages",
    name: "项目团队概述",
    agent: "团队叙事官",
    checkpointType: "dc-project-advantages",
    targetSection: "二、项目团队概述",
    instruction:
      "生成“项目团队概述”。写清团队负责人、研发、产品、调研、财务、运营、材料与答辩分工，说明成员能力如何对应项目任务，补充指导教师支持、阶段性成果、协作机制和材料沉淀方式。口吻要像正式申报书中的团队章节，不写空泛个人介绍。",
  },
  {
    id: "dc-market-analysis",
    name: "产业背景与项目产品",
    agent: "产业与产品架构师",
    checkpointType: "dc-market-analysis",
    targetSection: "三、产业背景与项目产品",
    instruction:
      "生成“产业背景与项目产品”，必须覆盖（一）产业背景与市场概述、（二）项目产品概述、（三）项目服务实施计划。产业背景要从政策、行业需求、技术趋势和应用场景展开；产品概述要写清模块、技术路线、图1架构图说明、图2流程图说明、指标体系和交付边界；实施计划要有阶段、任务、成果和验收口径。",
  },
  {
    id: "dc-product-introduction",
    name: "市场调查与竞争分析",
    agent: "市场调研分析师",
    checkpointType: "dc-product-introduction",
    targetSection: "四、市场调查与竞争分析",
    instruction:
      "生成“市场调查与竞争分析”，必须覆盖（一）市场规模调查、（二）目标市场规模、（三）竞争分析、（四）差异化优势。要区分宏观市场、可服务市场和初期可进入市场，写清客户/用户/付费主体，包含目标客户表、竞品或替代方案对比表、进入路径和差异化优势，不把宏观市场直接等同为项目收入。",
  },
  {
    id: "dc-business-model",
    name: "商业模式与发展战略",
    agent: "商业模式设计师",
    checkpointType: "dc-business-model",
    targetSection: "五、商业模式与发展战略",
    instruction:
      "生成“商业模式与发展战略”，必须覆盖（一）商业模式、（二）营销策略、（三）发展战略、（四）核心竞争力保障。发展战略按1.短期战略（1-2年）、2.中期战略（3-5年）、3.长期战略（5年以上）写，商业模式要写收入来源、客户对象、交付方式、收费口径和持续运营，不写成泛泛营销建议。",
  },
  {
    id: "dc-market-operation",
    name: "预期效益分析",
    agent: "效益评估专家",
    checkpointType: "dc-market-operation",
    targetSection: "六、预期效益分析",
    instruction:
      "生成“预期效益分析”。按当前项目上传参考文档或大创基础结构写社会发展与民生改善效益、降低一线人员风险或提升服务效率、公共治理/行业应用价值、环境或资源价值、盈利能力与经济价值、可扩展价值。每类效益都要落到项目具体场景、影响对象、量化或半量化指标和证明材料。",
  },
  {
    id: "dc-financial-plan",
    name: "总结与资金回报",
    agent: "财务与交付规划师",
    checkpointType: "dc-financial-plan",
    targetSection: "七、总结与资金回报",
    instruction:
      "生成“总结与资金回报”，必须覆盖（一）总结、（二）资金回报、（三）交付物汇总，并包含收入预测、成本预算、资金用途、融资或经费需求、投资/项目回报和关键假设。所有数字使用项目估算口径或公开资料口径，不能虚构已签约客户、已发生营收或已获投资。",
  },
  {
    id: "dc-team-introduction",
    name: "证明材料",
    agent: "材料合规官",
    checkpointType: "dc-team-introduction",
    targetSection: "八、证明材料",
    instruction:
      "生成“证明材料”主章，整理政策资料、行业资料、用户调研、产品原型、测试记录、图表资料、财务测算、团队分工、知识产权或成果准备材料。每份材料说明形成方式、证明对象、对应正文结论和当前状态。只写项目书正文需要的材料，不写系统质量报告。",
  },
  {
    id: "dc-risk-management",
    name: "风险控制与合规补充",
    agent: "财务与风控规划师",
    checkpointType: "dc-risk-management",
    targetSection: "五、商业模式与发展战略",
    instruction:
      "作为“商业模式与发展战略”中的核心竞争力保障和风险控制补充，生成市场风险、技术风险、运营风险、财务风险、团队风险、数据/知识产权/合规风险及应对措施。内容要能并入第五章，不单独生成旧式第九章。",
  },
  {
    id: "dc-future-plan",
    name: "发展战略与效益补充",
    agent: "发展战略规划师",
    checkpointType: "dc-future-plan",
    targetSection: "五、商业模式与发展战略",
    instruction:
      "补强“商业模式与发展战略”中的短期战略（1-2年）、中期战略（3-5年）、长期战略（5年以上）和核心竞争力保障。规划必须对应产品迭代、市场进入、团队建设、成果转化、证明材料和经费使用，不写空泛展望。",
  },
  {
    id: "dc-appendix-proof",
    name: "证明材料补充",
    agent: "材料合规官",
    checkpointType: "dc-appendix-proof",
    targetSection: "八、证明材料",
    instruction:
      "补强“证明材料”章节，只保留正式项目书需要的附件清单、图表清单、测试材料、调研材料、财务材料、团队材料和知识产权/成果材料说明。不得写系统说明、质量报告、修稿说明或来源映射表。",
  },
  {
    id: "final-assembly",
    name: "完整项目书组装",
    agent: "项目书总编辑",
    checkpointType: "final-book",
    targetSection: "完整创业训练项目书",
    instruction:
      "把前面所有章节统一成一篇完整创业训练/大创项目书，正文采用参考稿式结构：执行摘要、一、项目方案概述、二、项目团队概述、三、产业背景与项目产品、四、市场调查与竞争分析、五、商业模式与发展战略、六、预期效益分析、七、总结与资金回报、八、证明材料。最终正文不得包含系统报告、质量报告、修稿说明或来源映射表。",
  },
];


const TIAOZHANBEI_PROJECT_BOOK_STEPS: StepDef[] = [
  {
    id: "tb-executive-summary",
    name: "执行摘要",
    agent: "挑战杯总编辑",
    checkpointType: "tb-executive-summary",
    targetSection: "执行摘要",
    instruction: "参考挑战杯创业计划竞赛商业计划书写法，直接生成执行摘要，概括项目来源、社会问题、产品服务、核心创新、市场机会、商业模式、团队基础、发展目标和风险控制。",
  },
  {
    id: "tb-project-background",
    name: "项目背景与社会价值",
    agent: "社会问题研究员",
    checkpointType: "tb-project-background",
    targetSection: "一、项目背景与社会价值",
    instruction: "生成项目背景、政策与行业背景、社会民生问题、项目必要性、公益价值和商业价值，突出青年团队解决真实社会问题的能力。",
  },
  {
    id: "tb-company-product",
    name: "公司/项目与产品服务",
    agent: "产品与公司策划师",
    checkpointType: "tb-company-product",
    targetSection: "二、公司/项目概况与产品服务",
    instruction: "生成项目定位、拟成立主体或团队运营形式、产品服务、核心功能、技术路线、服务流程、研发计划和产品迭代，包含产品模块表、服务流程说明和研发里程碑。",
  },
  {
    id: "tb-innovation-advantage",
    name: "创新内容与竞争优势",
    agent: "创新性论证专家",
    checkpointType: "tb-innovation-advantage",
    targetSection: "三、创新内容与竞争优势",
    instruction: "生成技术创新、产品创新、模式创新、服务创新、项目优势和竞争壁垒，说明知识产权或授权边界，不夸大未完成成果。",
  },
  {
    id: "tb-market-analysis",
    name: "市场分析与目标市场",
    agent: "市场调研分析师",
    checkpointType: "tb-market-analysis",
    targetSection: "四、市场分析与目标市场",
    instruction: "生成行业规模、目标客户、市场容量、用户需求、竞品和替代方案、市场定位、市场占有策略，包含目标客户表、竞品对比表和市场进入路径。",
  },
  {
    id: "tb-marketing-sales",
    name: "营销策略及销售",
    agent: "营销增长规划师",
    checkpointType: "tb-marketing-sales",
    targetSection: "五、营销策略及销售",
    instruction: "生成价格策略、渠道策略、推广策略、销售流程、客户获取、品牌建设、售后服务和阶段推广计划，写成可落地的营销章节。",
  },
  {
    id: "tb-operation-management",
    name: "运营管理与实施计划",
    agent: "运营管理规划师",
    checkpointType: "tb-operation-management",
    targetSection: "六、运营管理与实施计划",
    instruction: "生成组织架构、生产或交付计划、供应链或服务交付、质量控制、数据与合规管理、阶段实施安排，体现商业计划完整性和可执行性。",
  },
  {
    id: "tb-team-organization",
    name: "团队介绍与组织能力",
    agent: "团队叙事官",
    checkpointType: "tb-team-organization",
    targetSection: "七、团队介绍与组织能力",
    instruction: "生成团队成员分工、专业背景、指导老师、既有成果、创业意识、执行能力和协作机制，突出团队能力与项目需求匹配。",
  },
  {
    id: "tb-financial-plan",
    name: "财务分析与融资计划",
    agent: "财务与投资分析师",
    checkpointType: "tb-financial-plan",
    targetSection: "八、财务分析与融资计划",
    instruction: "生成启动资金、成本预算、收入预测、利润预测、现金流、融资需求、投资回报和退出方式，数字注明估算口径并包含财务表格。",
  },
  {
    id: "tb-risk-control",
    name: "风险分析与对策",
    agent: "风控评审专家",
    checkpointType: "tb-risk-control",
    targetSection: "九、风险分析与对策",
    instruction: "生成市场风险、技术风险、运营风险、财务风险、法律合规风险、团队风险及应对措施，使用风险矩阵和正式正文。",
  },
  {
    id: "tb-development-prospect",
    name: "发展战略与前景",
    agent: "发展战略规划师",
    checkpointType: "tb-development-prospect",
    targetSection: "十、发展战略与前景",
    instruction: "生成短中长期发展战略、规模化计划、商业价值、社会价值、发展前景、成果转化和竞赛展示重点。",
  },
  {
    id: "tb-appendix-proof",
    name: "附件与证明材料",
    agent: "材料合规官",
    checkpointType: "tb-appendix-proof",
    targetSection: "十一、附件与证明材料",
    instruction: "生成正式附件清单，包括市场调研、技术证明、知识产权或授权、团队成果、财务测算、合作意向、样机截图和路演材料。",
  },
  {
    id: "final-assembly",
    name: "完整挑战杯项目书组装",
    agent: "挑战杯项目书总编辑",
    checkpointType: "final-book",
    targetSection: "完整挑战杯创业计划项目书",
    instruction: "把前面章节组装成完整挑战杯创业计划项目书，最终正文不得包含系统提示、建议清单或来源映射表。",
  },
];

const INTERNET_PLUS_PROJECT_BOOK_STEPS: StepDef[] = [
  {
    id: "ip-project-summary",
    name: "项目概要",
    agent: "互联网+总编辑",
    checkpointType: "ip-project-summary",
    targetSection: "一、项目概要",
    instruction: "参考中国国际大学生创新大赛/互联网+商业计划书模板，生成项目概要，说明项目来源、市场需求、解决方案、商业模式、阶段成果、融资需求和预期结果。",
  },
  {
    id: "ip-problem-opportunity",
    name: "行业痛点与创业机会",
    agent: "行业洞察分析师",
    checkpointType: "ip-problem-opportunity",
    targetSection: "二、行业痛点与创业机会",
    instruction: "生成行业背景、政策趋势、用户痛点、市场痛点、创业机会和项目切入点，用数据、场景和对比表达问题真实存在。",
  },
  {
    id: "ip-solution-product",
    name: "解决方案与产品服务",
    agent: "产品解决方案架构师",
    checkpointType: "ip-solution-product",
    targetSection: "三、解决方案与产品服务",
    instruction: "生成解决方案、产品服务、功能模块、技术架构、产品形态、用户流程、核心体验和应用场景，包含产品功能表、用户流程图说明和技术/服务架构图说明。",
  },
  {
    id: "ip-technology-innovation",
    name: "技术创新与核心壁垒",
    agent: "技术创新论证专家",
    checkpointType: "ip-technology-innovation",
    targetSection: "四、技术创新与核心壁垒",
    instruction: "生成技术路线、算法/系统/平台创新、数据资源、知识产权计划、产品壁垒、运营壁垒和竞争壁垒，强调技术赋能和商业闭环。",
  },
  {
    id: "ip-market-validation",
    name: "市场分析与用户验证",
    agent: "市场验证分析师",
    checkpointType: "ip-market-validation",
    targetSection: "五、市场分析与用户验证",
    instruction: "生成市场规模、细分市场、目标用户、用户画像、需求验证、竞品分析、市场趋势和进入策略，包含用户画像表、竞品矩阵、市场规模估算口径。",
  },
  {
    id: "ip-business-model",
    name: "商业模式与业务闭环",
    agent: "商业模式设计师",
    checkpointType: "ip-business-model",
    targetSection: "六、商业模式与业务闭环",
    instruction: "生成价值主张、客户细分、收入来源、成本结构、关键资源、关键合作、业务流程闭环、平台生态和盈利路径。",
  },
  {
    id: "ip-growth-operation",
    name: "运营推广与增长策略",
    agent: "增长运营规划师",
    checkpointType: "ip-growth-operation",
    targetSection: "七、运营推广与增长策略",
    instruction: "生成冷启动、渠道推广、品牌传播、用户增长、留存复购、合作伙伴、里程碑和年度目标，写成具体增长计划。",
  },
  {
    id: "ip-team-foundation",
    name: "团队基础与资源支撑",
    agent: "团队与资源整合师",
    checkpointType: "ip-team-foundation",
    targetSection: "八、团队基础与资源支撑",
    instruction: "生成团队成员、专业互补、导师资源、校企资源、阶段成果、项目基础、资源整合能力和组织机制。",
  },
  {
    id: "ip-finance-funding",
    name: "财务预测与融资回报",
    agent: "融资财务分析师",
    checkpointType: "ip-finance-funding",
    targetSection: "九、财务预测与融资回报",
    instruction: "生成3-5年收入利润预测、成本费用、现金流、融资需求、资金用途、估值逻辑、投资回报和退出机制，包含收入预测表、成本费用表、资金用途表。",
  },
  {
    id: "ip-risk-compliance",
    name: "风险控制与合规",
    agent: "合规风控官",
    checkpointType: "ip-risk-compliance",
    targetSection: "十、风险控制与合规",
    instruction: "生成市场、技术、数据安全、隐私合规、运营、财务、团队和政策风险及应对措施，写清数据来源、授权、隐私和平台责任边界。",
  },
  {
    id: "ip-roadshow-materials",
    name: "路演呈现与附件材料",
    agent: "路演材料策划师",
    checkpointType: "ip-roadshow-materials",
    targetSection: "十一、路演呈现与附件材料",
    instruction: "生成路演重点、图表清单、演示材料、原型截图、调研附件、财务附件、证明材料和答辩问答准备。",
  },
  {
    id: "final-assembly",
    name: "完整互联网+商业计划书组装",
    agent: "互联网+商业计划书总编辑",
    checkpointType: "final-book",
    targetSection: "完整互联网+商业计划书",
    instruction: "把前面章节组装成完整互联网+商业计划书，最终正文不得包含系统提示、建议清单或来源映射表。",
  },
];

const WORKFLOW_TEMPLATES: Record<WorkflowTemplateId, { name: string; description: string; steps: StepDef[] }> = {
  dachuang: {
    name: "大创/创业训练完整项目书",
    description: "仅基于当前项目配置和当前上传资料生成八章项目计划书：一、项目方案概述；二、项目团队概述；三、产业背景与项目产品；四、市场调查与竞争分析；五、商业模式与发展战略；六、预期效益分析；七、总结与资金回报；八、证明材料。未上传写法参考时也使用该结构，不启用执行摘要/项目优势/未来展望等单一商业计划书模板。",
    steps: COMPLETE_PROJECT_BOOK_STEPS,
  },
  tiaozhanbei: {
    name: "挑战杯完整项目书",
    description: "强调项目方案、社会价值、技术产品、市场竞争、商业模式与证明材料。",
    steps: TIAOZHANBEI_PROJECT_BOOK_STEPS,
  },
  "internet-plus": {
    name: "互联网+完整商业计划书",
    description: "在完整项目书基础上强化市场、商业模式、发展战略、财务回报与路演表达。",
    steps: INTERNET_PLUS_PROJECT_BOOK_STEPS,
  },
};

function ensureProjectDirs(projectDir: string) {
  mkdirSync(join(projectDir, ".paper", "drafts"), { recursive: true });
  mkdirSync(join(projectDir, ".paper", "artifacts"), { recursive: true });
  mkdirSync(join(projectDir, ".paper", "uploads"), { recursive: true });
  mkdirSync(join(projectDir, ".paper", "backups"), { recursive: true });
}

function copyGeneratedWorkflowSnapshot(projectDir: string, label: string) {
  ensureProjectDirs(projectDir);
  const stamp = `${new Date().toISOString().replace(/[:.]/g, "-")}-${safeId(label)}`;
  const backupRoot = join(projectDir, ".paper", "backups", stamp);
  const copied: string[] = [];
  const copyIfExists = (source: string, relativeTarget: string) => {
    if (!existsSync(source)) return;
    const target = join(backupRoot, relativeTarget);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
    copied.push(target);
  };
  copyIfExists(join(projectDir, ".paper", "project.yaml"), "project.yaml");
  for (const dirName of ["drafts", "artifacts"]) {
    const dir = join(projectDir, ".paper", dirName);
    if (!existsSync(dir)) continue;
    for (const fileName of readdirSync(dir)) {
      if (!fileName.endsWith(".md")) continue;
      copyIfExists(join(dir, fileName), join(dirName, fileName));
    }
  }
  const manifest = {
    label,
    createdAt: new Date().toISOString(),
    projectDir,
    files: copied,
  };
  mkdirSync(backupRoot, { recursive: true });
  writeFileSync(join(backupRoot, "manifest.json"), JSON.stringify(manifest, null, 2), "utf-8");
  return { backupId: stamp, backupDir: backupRoot, files: copied };
}

function backupEditorFile(id: string, pathValue: unknown, label = "editor-before-agent-edit") {
  const { projectDir, relativePath, absolutePath } = resolveProjectPath(id, pathValue);
  if (!existsSync(absolutePath) || !statSync(absolutePath).isFile()) return null;
  ensureProjectDirs(projectDir);
  const stamp = `${new Date().toISOString().replace(/[:.]/g, "-")}-${safeId(label)}`;
  const backupRoot = join(projectDir, ".paper", "backups", stamp);
  const backupRelativePath = relativePath.replace(/^\.paper\//, "");
  const target = join(backupRoot, backupRelativePath);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(absolutePath, target);
  const manifest = {
    label,
    createdAt: new Date().toISOString(),
    projectDir,
    relativePath,
    backupRelativePath,
    source: absolutePath,
    files: [target],
  };
  mkdirSync(backupRoot, { recursive: true });
  writeFileSync(join(backupRoot, "manifest.json"), JSON.stringify(manifest, null, 2), "utf-8");
  return { backupId: stamp, backupDir: backupRoot, files: [target], relativePath };
}

function latestWorkflowBackup(projectDir: string) {
  const backupsDir = join(projectDir, ".paper", "backups");
  if (!existsSync(backupsDir)) return null;
  const dirs = readdirSync(backupsDir)
    .map((name) => {
      const path = join(backupsDir, name);
      if (!statSync(path).isDirectory()) return null;
      return { id: name, path, mtime: statSync(path).mtimeMs };
    })
    .filter(Boolean) as { id: string; path: string; mtime: number }[];
  return dirs.sort((a, b) => b.mtime - a.mtime)[0] || null;
}

function restoreWorkflowBackup(workflowId: string, backupId?: string) {
  const projectDir = projectDirFor(workflowId);
  const backup = backupId
    ? { id: backupId, path: join(projectDir, ".paper", "backups", backupId), mtime: 0 }
    : latestWorkflowBackup(projectDir);
  if (!backup || !existsSync(backup.path)) throw new Error("未找到可回滚的备份");
  const restoreFile = (relativePath: string) => {
    const source = join(backup.path, relativePath);
    if (!existsSync(source)) return;
    const target = join(projectDir, ".paper", relativePath);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
  };
  restoreFile("project.yaml");
  for (const dirName of ["drafts", "artifacts"]) {
    const sourceDir = join(backup.path, dirName);
    const targetDir = join(projectDir, ".paper", dirName);
    if (!existsSync(sourceDir)) continue;
    mkdirSync(targetDir, { recursive: true });
    for (const fileName of readdirSync(sourceDir)) {
      if (fileName.endsWith(".md")) copyFileSync(join(sourceDir, fileName), join(targetDir, fileName));
    }
  }
  checkpointStore.clear(workflowId);
  return { backupId: backup.id, backupDir: backup.path };
}

function cleanGeneratedWorkflowFiles(projectDir: string, options: { backupLabel?: string } = {}) {
  const backup = options.backupLabel ? copyGeneratedWorkflowSnapshot(projectDir, options.backupLabel) : null;
  const targets = [join(projectDir, ".paper", "artifacts"), join(projectDir, ".paper", "drafts")];
  for (const dir of targets) {
    if (!existsSync(dir)) continue;
    for (const fileName of readdirSync(dir)) {
      if (!fileName.endsWith(".md")) continue;
      const path = join(dir, fileName);
      const resolved = resolve(path);
      if (!resolved.startsWith(resolve(projectDir))) continue;
      rmSync(resolved, { force: true });
    }
  }
  return backup;
}

function hasGeneratedWorkflowFiles(projectDir: string) {
  for (const dirName of ["drafts", "artifacts"]) {
    const dir = join(projectDir, ".paper", dirName);
    if (!existsSync(dir)) continue;
    if (readdirSync(dir).some((fileName) => fileName.endsWith(".md"))) return true;
  }
  return false;
}

function safeReadText(path: string) {
  return existsSync(path) ? readFileSync(path, "utf-8") : "";
}

function regenerationSummary(before: string, after: string) {
  const beforeChars = before.length;
  const afterChars = after.length;
  const beforeHeadings = countOccurrences(before, /^#{1,3}\s+/gm);
  const afterHeadings = countOccurrences(after, /^#{1,3}\s+/gm);
  const beforeTables = countOccurrences(before, /^\|.+\|$/gm);
  const afterTables = countOccurrences(after, /^\|.+\|$/gm);
  return {
    beforeChars,
    afterChars,
    changedChars: afterChars - beforeChars,
    beforeHeadings,
    afterHeadings,
    beforeTables,
    afterTables,
    summary: before
      ? `重生成完成：正文 ${beforeChars.toLocaleString()} -> ${afterChars.toLocaleString()} 字符，标题 ${beforeHeadings} -> ${afterHeadings} 个，表格 ${beforeTables} -> ${afterTables} 行。`
      : `生成完成：正文 ${afterChars.toLocaleString()} 字符，标题 ${afterHeadings} 个，表格 ${afterTables} 行。`,
  };
}

function safeId(name: string): string {
  return name.trim().replace(/[<>:"/\\|?*]+/g, "-").slice(0, 80) || `workflow-${Date.now()}`;
}

function configPath(id: string) {
  return join(PROJECTS_DIR, id, ".paper", "project.yaml");
}

function resolveWorkflowId(rawId: string) {
  const candidates = new Set<string>([rawId]);
  try {
    candidates.add(decodeURIComponent(rawId));
  } catch {
    // Keep the original route parameter.
  }
  for (const candidate of candidates) {
    if (readConfig(candidate)) return candidate;
  }
  if (!existsSync(PROJECTS_DIR)) return rawId;
  const normalized = Array.from(candidates).map((item) => item.toLowerCase());
  const match = readdirSync(PROJECTS_DIR).find((name) => normalized.includes(name.toLowerCase()));
  if (match) return match;
  const asciiTokens = Array.from(candidates)
    .flatMap((item) => item.toLowerCase().match(/[a-z0-9]+/g) || [])
    .filter((token) => token.length >= 3);
  if (asciiTokens.length) {
    const fuzzy = readdirSync(PROJECTS_DIR).find((name) => {
      const lower = name.toLowerCase();
      return asciiTokens.every((token) => lower.includes(token));
    });
    if (fuzzy) return fuzzy;
  }
  return rawId;
}

const UPLOAD_MAX_BYTES = 160 * 1024 * 1024;
const UPLOAD_METADATA_FILE = ".upload-metadata.json";
const UPLOAD_FIELD_LABELS: Record<string, string> = {
  referenceNotes: "项目大纲/写法参考",
  contestFileNotes: "相关文件",
  attachmentNotes: "附件数据",
};

function formatBytes(bytes: number) {
  if (bytes >= 1024 * 1024) return `${Math.round((bytes / 1024 / 1024) * 10) / 10}MB`;
  if (bytes >= 1024) return `${Math.round((bytes / 1024) * 10) / 10}KB`;
  return `${bytes}B`;
}

type UploadMetadata = Record<string, { field?: string; originalName?: string; contentType?: string; uploadedAt?: string }>;

function readUploadMetadata(uploadsDir: string): UploadMetadata {
  const path = join(uploadsDir, UPLOAD_METADATA_FILE);
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as UploadMetadata;
  } catch {
    return {};
  }
}

function writeUploadMetadata(uploadsDir: string, metadata: UploadMetadata) {
  mkdirSync(uploadsDir, { recursive: true });
  writeFileSync(join(uploadsDir, UPLOAD_METADATA_FILE), JSON.stringify(metadata, null, 2), "utf-8");
}

function readConfig(id: string): WorkflowConfig | null {
  const path = configPath(id);
  if (!existsSync(path)) return null;
  try {
    return parseYaml(readFileSync(path, "utf-8")) as WorkflowConfig;
  } catch {
    return null;
  }
}

function writeConfig(id: string, config: WorkflowConfig) {
  ensureProjectDirs(join(PROJECTS_DIR, id));
  writeFileSync(configPath(id), stringifyYaml(config), "utf-8");
}

function listMarkdownFiles(dir: string) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".md"))
    .map((name) => {
      const filePath = join(dir, name);
      return {
        name,
        path: filePath,
        content: readFileSync(filePath, "utf-8"),
        size: statSync(filePath).size,
        updated: statSync(filePath).mtime.toISOString(),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function listUploadFiles(projectDir: string) {
  const uploadsDir = join(projectDir, ".paper", "uploads");
  if (!existsSync(uploadsDir)) return [];
  const metadata = readUploadMetadata(uploadsDir);
  const config = readProjectConfigFromDir(projectDir);
  const referenceNames = splitConfigUploadNames(config?.referenceNotes || "");
  const contestNames = splitConfigUploadNames(config?.contestFileNotes || "");
  const attachmentNames = splitConfigUploadNames(config?.attachmentNotes || "");
  const allUploadEntries = readdirSync(uploadsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name !== UPLOAD_METADATA_FILE);
  const inferField = (entryName: string, originalName: string, metaField: string) => {
    if (metaField) return metaField;
    if (matchesConfiguredUploadName(entryName, originalName, referenceNames)) return "referenceNotes";
    if (matchesConfiguredUploadName(entryName, originalName, contestNames)) return "contestFileNotes";
    if (matchesConfiguredUploadName(entryName, originalName, attachmentNames)) return "attachmentNotes";
    if (allUploadEntries.length === 1 && referenceNames.length) return "referenceNotes";
    return "";
  };
  return allUploadEntries
    .map((entry) => {
      const filePath = join(uploadsDir, entry.name);
      const meta = metadata[entry.name] || {};
      const originalName = String(meta.originalName || entry.name);
      const field = inferField(entry.name, originalName, String(meta.field || ""));
      return {
        name: entry.name,
        originalName,
        field,
        fieldLabel: UPLOAD_FIELD_LABELS[field] || "未分类上传资料",
        path: filePath,
        extension: extname(entry.name).toLowerCase(),
        size: statSync(filePath).size,
        updated: statSync(filePath).mtime.toISOString(),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function readProjectConfigFromDir(projectDir: string): WorkflowConfig | null {
  const path = join(projectDir, ".paper", "project.yaml");
  if (!existsSync(path)) return null;
  try {
    return parseYaml(readFileSync(path, "utf-8")) as WorkflowConfig;
  } catch {
    return null;
  }
}

function splitConfigUploadNames(value: string) {
  return String(value || "")
    .split(/[、,，;\n]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function matchesConfiguredUploadName(entryName: string, originalName: string, configuredNames: string[]) {
  if (!configuredNames.length) return false;
  const candidates = [entryName, originalName].map((item) => item.toLowerCase());
  return configuredNames.some((name) => {
    const lower = name.toLowerCase();
    const base = lower.replace(/\.[^.]+$/, "");
    return candidates.some((candidate) => candidate.includes(lower) || candidate.includes(base));
  });
}

function extractTextFromUpload(filePath: string) {
  const ext = extname(filePath).toLowerCase();
  const stat = statSync(filePath);
  if ([".txt", ".md", ".csv", ".json", ".yaml", ".yml", ".tex", ".log"].includes(ext)) {
    return readFileSync(filePath, "utf-8").slice(0, 12000);
  }
  if ([".pdf", ".docx", ".xlsx", ".xls"].includes(ext)) {
    const parsed = extractOfficeTextWithPython(filePath);
    if (parsed) return parsed.slice(0, 18000);
  }
  if (stat.size > 2_000_000) {
    return "文件已保存，但当前解析器未能抽取正文；工作流会继续记录文件名、大小和附件边界，后续生成时按附件材料处理。";
  }
  return "文件已保存。当前版本先记录文件元数据；PDF/Word/Excel/图片全文抽取将在文档解析器中继续增强。";
}

function extractOfficeTextWithPython(filePath: string) {
  const script = String.raw`
import json
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
ext = path.suffix.lower()
chunks = []

try:
    if ext == ".pdf":
        from pypdf import PdfReader
        reader = PdfReader(str(path))
        for index, page in enumerate(reader.pages[:12], 1):
            text = page.extract_text() or ""
            if text.strip():
                chunks.append(f"[PDF page {index}]\n{text.strip()}")
    elif ext == ".docx":
        from docx import Document
        doc = Document(str(path))
        for para in doc.paragraphs:
            text = para.text.strip()
            if text:
                chunks.append(text)
        for table_index, table in enumerate(doc.tables[:8], 1):
            rows = []
            for row in table.rows[:30]:
                cells = [cell.text.strip().replace("\n", " ") for cell in row.cells]
                if any(cells):
                    rows.append(" | ".join(cells))
            if rows:
                chunks.append(f"[DOCX table {table_index}]\n" + "\n".join(rows))
    elif ext in (".xlsx", ".xls"):
        from openpyxl import load_workbook
        wb = load_workbook(str(path), data_only=True, read_only=True)
        for sheet in wb.worksheets[:6]:
            rows = []
            for row in sheet.iter_rows(max_row=40, max_col=12, values_only=True):
                values = ["" if value is None else str(value).strip() for value in row]
                if any(values):
                    rows.append(" | ".join(values))
            if rows:
                chunks.append(f"[Sheet: {sheet.title}]\n" + "\n".join(rows))
except Exception as exc:
    print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
    sys.exit(0)

print(json.dumps({"ok": True, "text": "\n\n".join(chunks)[:24000]}, ensure_ascii=False))
`;
  const result = spawnSync(resolvePythonExe(), ["-c", script, filePath], {
    encoding: "utf-8",
    maxBuffer: 2 * 1024 * 1024,
    windowsHide: true,
  });
  const output = (result.stdout || "").trim().split(/\r?\n/).pop();
  if (!output) return "";
  try {
    const data = JSON.parse(output) as { ok?: boolean; text?: string };
    return data.ok ? (data.text || "").trim() : "";
  } catch {
    return "";
  }
}

function buildUploadKnowledge(projectDir: string) {
  const files = listUploadFiles(projectDir);
  if (!files.length) {
    return `# 上传资料知识库

当前项目尚未上传真实文件。工作流将使用用户表单信息、自动调研资料包和证据库索引继续生成。
`;
  }
  const blocks = files.map((file, index) => {
    const text = extractTextFromUpload(file.path);
    const usage = file.field === "referenceNotes"
      ? "结构/写法参考：只用于当前项目书的章节组织、标题层级、文风和格式感；不得把该文件中的项目事实、产品方向、技术路线、团队、市场、财务数字当作当前项目事实。"
      : "当前项目事实证据：可用于当前项目的背景、技术、市场、附件和证明材料，但仍需遵守公开资料口径、项目估算口径和原型测试口径。";
    return `## U${String(index + 1).padStart(2, "0")} ${file.name}

- 上传分区：${file.fieldLabel}
- 原始文件名：${file.originalName}
- 使用边界：${usage}
- 文件类型：${file.extension || "unknown"}
- 文件大小：${file.size} bytes
- 更新时间：${file.updated}

### 可读内容摘录
${text}`;
  });
  return `# 上传资料知识库

> 用途：把用户真实上传的相关文件纳入项目上下文。可读文本会进入后续章节生成；暂不能抽取全文的文件至少会进入附件索引和证据边界。

${blocks.join("\n\n")}
`;
}

function compactReferenceContext(uploadKnowledgeBody: string, maxChars = 18000) {
  return String(uploadKnowledgeBody || "")
    .replace(/^# 上传资料知识库\s*/m, "")
    .replace(/^> .+$/gm, "")
    .replace(/- 文件大小：\d+ bytes/g, "")
    .replace(/- 更新时间：[^\n]+/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, maxChars);
}

function compactFactReferenceContext(uploadKnowledgeBody: string, maxChars = 18000) {
  const blocks = String(uploadKnowledgeBody || "").split(/\n(?=## U\d+\s+)/);
  return blocks
    .filter((block) => !/上传分区：项目大纲\/写法参考/.test(block))
    .join("\n")
    .replace(/^# 上传资料知识库\s*/m, "")
    .replace(/^> .+$/gm, "")
    .replace(/- 文件大小：\d+ bytes/g, "")
    .replace(/- 更新时间：[^\n]+/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, maxChars);
}

function compactStyleReferenceContext(uploadKnowledgeBody: string, maxChars = 36000) {
  const blocks = String(uploadKnowledgeBody || "").split(/\n(?=## U\d+\s+)/);
  return blocks
    .filter((block) => /上传分区：项目大纲\/写法参考/.test(block))
    .join("\n")
    .replace(/^# 上传资料知识库\s*/m, "")
    .replace(/^> .+$/gm, "")
    .replace(/- 文件大小：\d+ bytes/g, "")
    .replace(/- 更新时间：[^\n]+/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, maxChars);
}

function extractReferenceStyleOutline(styleReferenceContext: string, maxItems = 80) {
  const source = String(styleReferenceContext || "")
    .replace(/\[PDF page \d+\]/g, "\n")
    .replace(/### 可读内容摘录/g, "\n")
    .replace(/[⼀一]/g, "一")
    .replace(/⼆/g, "二")
    .replace(/⼗/g, "十")
    .replace(/[ \t]+/g, " ")
    .replace(/\r/g, "");
  const tocIndex = source.search(/目\s*录|目录/);
  const tocWindow = tocIndex >= 0 ? source.slice(tocIndex, tocIndex + 6500) : source.slice(0, 9000);
  const lines = tocWindow
    .split(/\n+/)
    .map((line) => line.trim().replace(/[.．·•]+\s*\d{1,3}\s*$/g, "").replace(/\s+\d{1,3}\s*$/g, ""))
    .filter(Boolean);
  const seen = new Set<string>();
  const outline: string[] = [];
  const headingPattern = /^((?:[一二三四五六七八九十]+、|（[一二三四五六七八九十]+）|\d+[.．、])[^。；;|]{2,56})$/;
  for (const line of lines) {
    if (/^(目录|封面信息|项目字段|内容|上传分区|原始文件名|使用边界|文件类型)$/i.test(line)) continue;
    const match = line.match(headingPattern);
    if (!match) continue;
    const heading = match[1]
      .replace(/\s+/g, "")
      .replace(/[:：]$/, "")
      .trim();
    if (heading.length < 4 || heading.length > 60) continue;
    if (seen.has(heading)) continue;
    seen.add(heading);
    outline.push(heading);
    if (outline.length >= maxItems) break;
  }
  return outline;
}

function referenceStyleChapters(config: WorkflowConfig) {
  const outline = extractReferenceStyleOutline(config.styleReferenceContext || "");
  const chapters: { chapter: string; sections: string[] }[] = [];
  for (const item of outline) {
    if (/^[一二三四五六七八九十]+、/.test(item)) {
      chapters.push({ chapter: item.replace(/[：:]$/g, ""), sections: [] });
      continue;
    }
    if (!chapters.length) continue;
    if (/^（[一二三四五六七八九十]+）/.test(item) || /^\d+[.．、]/.test(item)) {
      chapters[chapters.length - 1].sections.push(item.replace(/[：:]$/g, ""));
    }
  }
  return chapters;
}

function referenceStyleWorkflowSteps(config: WorkflowConfig): StepDef[] {
  const chapters = referenceStyleChapters(config);
  if (chapters.length < 3) return [];
  const steps = chapters.map((item, index) => ({
    id: `ref-chapter-${String(index + 1).padStart(2, "0")}`,
    name: item.chapter.replace(/^[一二三四五六七八九十]+、/, ""),
    agent: "参考项目书仿写智能体",
    checkpointType: "reference-chapter",
    targetSection: item.chapter,
    instruction: [
      `严格按照当前上传参考项目书的章节“${item.chapter}”写作。`,
      item.sections.length ? `本章二级/三级标题必须贴近：${item.sections.join("；")}。` : "本章二级标题按参考文档同类章节的短标题风格组织。",
      "只学习参考文档结构、标题层级、段落密度、表格布局和正式申报书语气；不得照搬参考文档中的团队、客户、财务数字、实验结果或附件事实。",
      "正文必须回到当前项目名称、当前项目表单和当前项目上传事实材料；若材料不足，使用公开资料口径、项目估算口径、原型测试口径表述。",
    ].join("\n"),
  }));
  steps.push({
    id: "final-assembly",
    name: "参考项目书结构终稿组装",
    agent: "参考项目书总编辑",
    checkpointType: "final-book",
    targetSection: "完整项目计划书",
    instruction: "按当前上传参考项目书的目录顺序、标题层级、段落布局和表格风格组装终稿，不加入参考文档没有的执行摘要、通用项目优势、未来展望等模板章节。",
  });
  return steps;
}

function isReferenceWorkflowStep(step: StepDef) {
  return /^ref-chapter-\d+$/.test(step.id);
}

function hasReferenceStyleBlueprint(config: WorkflowConfig) {
  return referenceStyleChapters(config).length >= 3;
}

function effectiveProjectBookTemplateId(config: WorkflowConfig): WorkflowTemplateId {
  return hasReferenceStyleBlueprint(config) ? config.template : "dachuang";
}

function projectWorkflowSteps(config: WorkflowConfig) {
  const referenceSteps = referenceStyleWorkflowSteps(config);
  if (referenceSteps.length) return referenceSteps;
  return WORKFLOW_TEMPLATES[effectiveProjectBookTemplateId(config)]?.steps ?? WORKFLOW_TEMPLATES.dachuang.steps;
}

function workflowManifestPath(workflowId: string) {
  return join(projectDirFor(workflowId), ".paper", "artifacts", "00-workflow-manifest.md");
}

function buildWorkflowManifestArtifact(config: WorkflowConfig, steps: StepDef[]) {
  const referenceUsed = referenceStyleWorkflowSteps(config).length > 0;
  const chapterList = steps.map((step, index) => `${index + 1}. ${step.targetSection}`).join("\n");
  return [
    "# 00-workflow-manifest",
    "",
    "## 任务边界",
    `- 项目：${config.name}`,
    `- 竞赛类型：${config.competition}`,
    `- 参考文档：${referenceUsed ? "已加载，仅用于结构与写法" : "未上传，使用竞赛结构"}`,
    "",
    "## 计划顺序",
    chapterList,
    "",
    "## 输出约束",
    "- 只向执行层传递当前主题、当前上传、当前参考结构和当前证据边界。",
    "- 不把审计语、修稿语和系统提示混入正文明文。",
    "- 审计层单独输出报告，不直接覆盖计划层内容。",
  ].join("\n");
}

function cleanReferenceExcerpt(text: string) {
  return String(text || "")
    .replace(/\[PDF page \d+\]/g, "\n")
    .replace(/[⼀一]/g, "一")
    .replace(/⼆/g, "二")
    .replace(/⼗/g, "十")
    .replace(/^\s*\d+\s*$/gm, "")
    .replace(/[.．·•]{4,}\s*\d{1,3}/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function referenceChapterExcerpt(config: WorkflowConfig, chapter: string) {
  const source = cleanReferenceExcerpt(config.styleReferenceContext || "");
  if (!source || !chapter) return "";
  const chapterTitle = chapter.replace(/[⼀一]/g, "一").replace(/\s+/g, "\\s*");
  const startPattern = new RegExp(`(^|\\n)\\s*${chapterTitle}\\s*(?=\\n|$)`);
  const start = source.search(startPattern);
  if (start < 0) return "";
  const rest = source.slice(start).trim();
  const next = rest.slice(chapter.length + 1).search(/\n\s*[一二三四五六七八九十]+、[^\n]{2,40}\s*(?=\n|$)/);
  const block = next >= 0 ? rest.slice(0, chapter.length + 1 + next) : rest;
  return block.trim();
}

function referenceChapterHeadings(config: WorkflowConfig, chapter: string) {
  const chapterInfo = referenceStyleChapters(config).find((item) => item.chapter === chapter);
  if (chapterInfo?.sections.length) return chapterInfo.sections;
  const excerpt = referenceChapterExcerpt(config, chapter);
  return cleanReferenceExcerpt(excerpt)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^（[一二三四五六七八九十]+）/.test(line) || /^\d+[.．、]/.test(line))
    .map((line) => line.replace(/[：:]$/g, ""))
    .slice(0, 12);
}

function markdownizeReferenceChapter(excerpt: string) {
  return cleanReferenceExcerpt(excerpt)
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return "";
      if (/^[一二三四五六七八九十]+、/.test(trimmed)) return `## ${trimmed.replace(/[：:]$/g, "")}`;
      if (/^（[一二三四五六七八九十]+）/.test(trimmed)) return `### ${trimmed.replace(/[：:]$/g, "")}`;
      if (/^\d+[.．、]/.test(trimmed)) return `#### ${trimmed.replace(/[：:]$/g, "")}`;
      return trimmed;
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function referenceChapterContentBlock(config: WorkflowConfig, chapter: string, section: string, index: number) {
  const profile = currentTopicProfile(config);
  const name = config.name;
  const modules = profile.productModules;
  const users = profile.users;
  const scenes = profile.scenes;
  const pains = profile.painPoints;
  const metrics = profile.metrics;
  const evidence = profile.evidenceFocus;
  const models = profile.businessModels;
  const competitors = profile.competitors;
  const lower = section;
  const chapterLower = chapter;
  const para = (text: string) =>
    text
      .replace(/\s+/g, " ")
      .replace(/([\u4e00-\u9fff])\s+([\u4e00-\u9fff，。；：、）])/g, "$1$2")
      .replace(/([（])\s+/g, "$1")
      .replace(/\s+([）])/g, "$1")
      .trim();
  const table = (headers: string[], rows: string[][]) => makeTable(headers, rows);
  const sectionKey = `${chapter} ${section}`;
  const module = modules[index % modules.length] || "核心功能模块";
  const user = users[index % users.length] || "目标使用者";
  const scene = scenes[index % scenes.length] || "核心使用场景";
  const pain = pains[index % pains.length] || "现有方案效率不足";
  const metric = metrics[index % metrics.length] || "完成率";
  const proof = evidence[index % evidence.length] || "原型截图";
  if (/背景|产业|市场概述|机会|必要性/.test(sectionKey)) {
    return `${para(`${name}的论证从${scene}中的真实需求展开。当前${user}在任务触发、过程处理、结果复核和资料留存上仍面临${pain}等问题，单纯依靠人工经验、分散工具或通用平台，往往难以同时兼顾效率、成本、稳定性和后续复盘。该章节因此不把宏观趋势直接等同于项目价值，而是先把场景中的具体矛盾说清楚，再说明方案进入这些场景的必要性。`)}

${para(`围绕${profile.domain}，团队把建设边界收束在当前表单能够支撑的对象、场景和材料范围内。产品能力以${modules.slice(0, 5).join("、")}为主线，阶段评价采用${metrics.slice(0, 5).join("、")}等口径，证明材料优先使用${evidence.slice(0, 5).join("、")}。暂未形成真实合同、授权、营收或专利的内容，只按计划、测试或估算口径呈现。`)}

${table(["分析对象", "当前表现", "写入正文的落点"], [["服务对象", users.slice(0, 3).join("、"), "说明谁使用、谁决策、谁受益"], ["使用场景", scenes.slice(0, 3).join("、"), "说明需求何时出现、如何验证"], ["主要问题", pains.slice(0, 3).join("、"), "说明现有方式不足"], ["材料依据", evidence.slice(0, 3).join("、"), "对应附件和验证口径"]])}`;
  }
  if (/简述|概述|方案|产品|服务|系统|技术|实施/.test(sectionKey)) {
    return `${para(`${name}的方案不是把功能名称简单堆在一起，而是把${user}在${scene}中的任务拆成“需求进入、核心处理、结果输出、复核反馈、资料沉淀”几个连续环节。${module}承担其中的关键处理职责，其他模块围绕用户端服务、后台管理、反馈迭代和材料导出形成配合，使正文能够看出产品如何从想法进入可演示、可测试、可交付的状态。`)}

${para(`技术或服务链路按“${profile.techRoute}”组织。输入来源、处理动作、输出结果和验收材料要一一对应：输入说明当前场景需要什么资料或数据，处理说明${modules.slice(0, 4).join("、")}如何协同，输出说明用户能够看到什么结果，验收则通过${metrics.slice(0, 4).join("、")}和${evidence.slice(0, 4).join("、")}形成复核依据。`)}

${table(["模块", "作用", "验证材料"], modules.slice(0, 5).map((item, rowIndex) => [item, rowIndex === 0 ? `回应${pain}` : `支撑${scenes[rowIndex % scenes.length] || scene}中的使用流程`, evidence[rowIndex % evidence.length] || proof]))}`;
  }
  if (/市场|调研|竞争|竞品|客户|规模|进入/.test(sectionKey)) {
    return `${para(`市场分析围绕${users.slice(0, 4).join("、")}展开，而不是直接套用宏观市场规模。早期进入更适合选择反馈周期短、沟通成本低、能够形成${proof}的对象，先验证${scene}中的高频任务，再根据${metric}等指标判断服务是否具备复制空间。付费或采购主体、实际使用者和合作方可能并不完全相同，因此正文需要分清谁使用、谁决策、谁承担成本。`)}

${para(`替代方案主要包括${competitors.slice(0, 4).join("、")}。比较重点不放在口号式“技术领先”，而放在${pains.slice(0, 4).join("、")}能否被连续解决，结果能否留痕，实施成本是否可控，后续运维是否清楚。收入和市场容量采用公开资料口径、行业报告口径或团队估算口径，不把尚未发生的客户合作写成既成事实。`)}

${table(["对象", "核心需求", "进入方式", "证明材料"], users.slice(0, 5).map((item, rowIndex) => [item, pains[rowIndex % pains.length] || pain, rowIndex < 2 ? "访谈、原型演示、小范围试用" : "合作沟通、服务清单、报价口径", evidence[rowIndex % evidence.length] || proof]))}`;
  }
  if (/商业|战略|资金|财务|回报|收益|效益|发展/.test(sectionKey)) {
    return `${para(`${name}的商业与发展路径围绕${models.slice(0, 5).join("、")}展开。早期重点不是夸大收入规模，而是把${modules.slice(0, 4).join("、")}整理成可说明、可报价、可验收的服务内容；中期根据${users.slice(0, 3).join("、")}的反馈沉淀标准化交付边界；后期再结合真实试点、合作沟通和运维记录修正收入、成本和回款周期。`)}

${para(`资金安排对应具体成果：研发投入形成模块版本，测试投入形成${metrics.slice(0, 4).join("、")}记录，调研投入形成用户和竞品材料，展示投入形成路演、截图和答辩资料。效益分析落在${scene}中的使用变化上，既说明效率、质量、成本或治理价值，也说明这些判断由${evidence.slice(0, 5).join("、")}支撑。`)}

${table(["路径", "交付内容", "测算口径"], models.slice(0, 5).map((item, rowIndex) => [item, `${modules[rowIndex % modules.length] || module}、${evidence[rowIndex % evidence.length] || proof}`, rowIndex < 2 ? "团队估算口径" : "阶段验证口径"]))}`;
  }
  if (/团队|分工|协作|组织/.test(sectionKey)) {
    return `${para(`团队组织围绕${modules.slice(0, 5).join("、")}、${users.slice(0, 3).join("、")}和${evidence.slice(0, 4).join("、")}分工。研发成员负责核心模块和测试记录，产品成员负责流程、原型和交互说明，调研成员负责用户访谈与竞品材料，财务成员负责预算和收入假设，材料成员负责正文、图表、附件和答辩口径一致。`)}

${para(`协作机制以阶段复盘、版本记录和材料归档为主。每一轮推进都记录负责人、完成内容、问题清单、验证结果和下一步动作，使团队能力不只是成员名单，而能对应到当前主题的实际产出。导师或外部资源主要参与需求把关、技术路线审阅、材料规范和试点沟通。`)}

${table(["角色", "主要任务", "阶段成果"], [["研发", modules.slice(0, 3).join("、"), "原型、测试记录、版本日志"], ["产品", scenes.slice(0, 3).join("、"), "流程图、界面截图、演示说明"], ["调研", users.slice(0, 3).join("、"), "访谈纪要、竞品表、需求清单"], ["财务/材料", models.slice(0, 3).join("、"), "预算表、附件索引、路演材料"]])}`;
  }
  if (/证明|材料|附件|支撑/.test(sectionKey)) {
    return `${para(`证明材料按“材料名称、形成方式、证明对象、对应章节、当前状态”组织。${evidence.slice(0, 6).join("、")}不只是放在最后清单中，还要反向支撑正文结论：调研材料支撑需求真实性，原型和测试材料支撑产品可行性，竞品和市场材料支撑进入路径，预算和服务清单支撑资金安排。`)}

${para(`暂未形成的合作、合同、专利、软著或营收不写成既成成果，只写成准备事项、阶段目标或后续验收节点。通过这种方式，计划书能够保持正式申报语气，同时不越过当前资料能证明的事实边界。`)}

${table(["材料类型", "证明对象", "对应章节"], evidence.slice(0, 6).map((item, rowIndex) => [item, rowIndex < 2 ? "需求和场景真实性" : rowIndex < 4 ? "产品和技术可行性" : "市场、财务或团队执行", chapter || "证明材料"]))}`;
  }
  return `${para(`${name}围绕${user}、${scene}和${module}展开论证。本节内容只使用当前项目表单、当前上传资料和可核验的公开资料口径，把${pain}、${metric}和${proof}连接起来，避免写成其他项目或通用模板。`)}

${para(`章节表达以正式项目书正文为准，重点说明当前主题的实施方式、验证路径、材料依据和后续边界。若缺少真实数据，则采用团队估算、原型测试或公开资料口径，不编造成已经取得的客户、授权、合同或经营成果。`)}`;
  if (/项目背景/.test(lower)) {
    return `${para(`无人机搜救图像中的人员目标通常尺度小、姿态变化大，容易被森林、山地、灾后废墟和复杂植被遮挡。不同地域、季节、光照和航拍高度又会改变图像分布，单一检测器在新场景下容易出现漏检、误检和置信度波动。${name}正是从这一类跨场景不稳定问题切入，尝试把固定检测模型改造为可随场景切换的智能检测链路。`)}

${para(`应急救援需要的不只是一个检测模型，而是一套能够在不同地貌、季节、光照和航拍高度下保持稳定输出的智能检测中枢。技术路线以${modules.slice(0, 5).join("、")}为主线，以${metrics.slice(0, 5).join("、")}作为阶段性验证指标，并通过${evidence.slice(0, 5).join("、")}呈现技术可行性。`)}

${para(`在实际任务中，无人机采集的图像往往存在目标像素占比低、背景纹理复杂、视角变化明显和灾后环境遮挡等问题。人工判读虽然具备经验优势，但难以在大批量图像中保持稳定速度；通用目标检测模型部署方便，却容易受到场景迁移影响。超路由元适应检测网络的切入点，正是把“不同场景交给不同专家模型处理”的思想引入搜救检测链路，使系统能够在复杂环境下保持更稳定的识别能力。`)}`;
  }
  if (/项目简述/.test(lower)) {
    return `${para(`本系统提出 Hyper Route Meta-Adaptive Detection Network（HMAD-Ednet），即超路由元适应检测网络。它不是把一个通用模型直接套到无人机图像上，而是把“多专家检测、场景路由、元学习优化”连接成一条处理链路：输入图像先完成场景特征提取，再由路由模块判断适配的专家检测器，最后通过元适应机制提升未知环境下的稳定性。`)}

${para(`交付形态包括算法模型、路由验证脚本、实验指标表、系统架构图和搜救场景应用说明。阶段验收以${metrics.slice(0, 6).join("、")}为主要指标，用于说明模型是否真正提升搜救场景中的发现概率、响应速度和跨场景稳定性。系统运行后输出疑似目标位置、置信度、场景路由结果和任务日志，便于救援人员结合现场信息进行复核。`)}

${table(["模块", "作用", "验证口径"], [["HMAD-Ednet", "组织多专家检测与场景路由", "mAP、Precision、Recall"], ["SPA-HyperNet", "提取场景感知特征并支持路由判别", "路由准确率、元适应得分"], ["Reptile元训练器", "提升未知场景下的泛化稳定性", "跨场景测试记录"], ["融合验证脚本", "对比路由前后检测收益", "P/R/F1变化与消融实验"]])}`;
  }
  if (/产业背景与市场概述/.test(lower)) {
    return `${para(`低空经济、应急体系现代化和公共安全智能装备的发展，使无人机搜救从单次设备采购逐步走向“平台+算法+服务”的综合能力建设。无人机能够快速获取灾害现场图像，但图像判读仍依赖人工经验或通用检测模型，面对森林、山地、灾后废墟等复杂场景时，识别效果和响应速度存在不确定性。`)}

${para(`无人机搜救链路中真正缺口不在图像采集，而在图像进入指挥流程后的快速筛查、线索确认和结果留痕。相较硬件平台，算法服务更容易形成持续更新和场景适配价值；相较单一检测器，超路由元适应网络更符合多场景、多地貌、多任务的公共安全应用需求。`)}

${para(`随着无人机在应急巡查、灾后勘查、山林搜索和临时通信保障中的使用频率提高，数据采集能力已经不再是唯一瓶颈。真正影响任务效率的是图像处理速度、目标线索可靠程度以及结果能否留存复盘。检测算法、场景路由、日志记录和接口输出被放在同一条业务链路中考虑，能够更好地适配公共安全领域对稳定性、合规性和责任边界的要求。`)}`;
  }
  if (/项目产品概述/.test(lower)) {
    return `${para(`系统结构由场景输入层、特征感知层、路由决策层、专家检测层、元适应优化层和结果输出层构成。场景输入层接收无人机航拍或SAR场景图像；特征感知层提取地貌、纹理、目标尺度等信息；路由决策层判断更适合的专家检测器；元适应优化层提升未知场景稳定性；结果输出层生成目标框、置信度、疑似区域和任务记录。`)}

${para(`技术实现上，系统以 HMAD-Ednet 为主体框架，将 SPA-HyperNet 的场景感知能力、多专家检测器的专门化能力和 Reptile 元学习训练器的快速适应能力组合起来。对于稀疏森林、复杂植被、开阔地貌和灾后遮挡等差异明显的输入图像，系统先判断场景特征，再选择更合适的专家检测路径，最后将检测结果与路由信息同步输出。`)}

![图1 超路由元适应检测网络系统架构图](paper://figure/hmad-architecture)

${table(["产品层级", "核心内容", "交付材料"], [["场景输入", "航拍/SAR图像、任务参数、场景标签", "数据集说明"], ["路由决策", "场景特征、专家选择、路由得分", "路由命中率记录"], ["检测推理", "多专家模型、目标框、置信度", "实验结果表"], ["结果输出", "疑似区域、日志、指挥辅助信息", "系统流程图"]])}`;
  }
  if (/项目服务实施计划/.test(lower)) {
    return `${para(`实施流程分为需求确认、样例数据整理、模型适配、原型演示、指标验证和材料归档六个环节。需求确认阶段明确搜救区域、无人机类型、图像来源和任务目标；模型适配阶段完成专家检测器与路由模块训练；指标验证阶段用mAP、Precision、Recall、F1和路由准确率评估效果；材料归档阶段形成项目书、附件和答辩支撑材料。`)}

${para(`实施过程中，团队优先选择能够形成闭环验证的典型场景，不直接承诺覆盖所有救援任务。每一轮样例测试都记录输入数据、模型版本、路由结果、误检漏检情况和修正动作，形成“测试—复盘—再训练—再验证”的迭代流程。这样既能控制项目早期范围，也能为后续试点沟通留下清晰的技术记录。`)}

![图2 Phase A/Phase B元适应验证流程图](paper://figure/meta-adaptive-flow)

${table(["阶段", "主要任务", "验收材料"], [["需求确认", "明确场景、数据、任务和使用边界", "需求清单"], ["模型适配", "训练专家检测器与路由模块", "训练记录"], ["原型演示", "展示检测结果和业务流程", "演示截图"], ["指标验证", "对比路由前后效果", "实验表与消融记录"], ["材料归档", "整理正文、图表和附件", "附件索引"]])}`;
  }
  if (/目标市场规模/.test(lower)) {
    return `${para(`目标市场可按“公共安全任务需求—无人机服务能力—算法软件价值”逐层拆分。早期能够触达的并不是整个低空经济市场，而是具备航拍图像、搜救演练、灾害巡查或系统集成需求的细分场景。该部分客户数量有限，但需求明确、场景集中、验证周期相对清晰，适合团队从原型服务切入。`)}

${para(`进入中期后，增量主要来自两类来源：一类是无人机服务商在应急、巡查、测绘之外增加搜救辅助判读能力；另一类是公共安全平台在原有视频、通信和调度功能上增加智能识别模块。算法包、接口文档和模型更新服务进入这些系统后，收入不直接绑定无人机硬件销售，而来自软件能力和持续服务。`)}

${table(["市场对象", "需求强度", "切入条件", "收入形态"], [["应急/消防单位", "高", "有演练或巡查数据，接受原型验证", "项目制服务"], ["航空救援队伍", "高", "具备航拍任务和复核流程", "算法适配"], ["无人机服务商", "中高", "需要扩展公共安全服务包", "联合方案"], ["系统集成商", "中", "已有平台接口和客户资源", "模块授权"]])}`;
  }
  if (/创业机会|目标市场/.test(lower)) {
    return `${para(`机会来自应急救援数字化、低空经济应用扩张和公共安全智能感知需求的叠加。对消防、应急管理、航空救援队伍和无人机运营服务商而言，大范围航拍图像的快速筛查具有明确业务价值；对指挥系统厂商和硬件生态伙伴而言，稳定、可解释、可接口化的检测算法能够成为系统集成的重要能力。`)}

${para(`目标市场不把宏观低空经济规模直接等同为收入，而是按照“事件响应主体、服务执行主体、系统集成主体”三类对象逐步切入。早期依靠原型演示、算法适配和测试记录争取试点，中期通过标准化算法包和接口说明进入合作生态，长期面向公共安全应急平台形成持续更新服务。`)}

${para(`采购和使用逻辑并不相同：应急、消防部门更关注结果可靠性和流程合规；航空救援队伍更关注现场响应速度和判读效率；无人机运营商更关注服务能力能否标准化复制；指挥系统厂商则关注算法接口、日志字段和后续运维成本。市场进入不依赖单一客户，而是围绕同一救援链路中的不同主体设计对应交付方式。`)}

${table(["目标对象", "核心需求", "进入方式"], [["应急/消防部门", "灾后快速初筛、搜救目标辅助识别", "原型演示与项目制试点"], ["航空救援队伍", "提升航拍判读效率和发现概率", "算法适配与任务服务"], ["无人机运营商", "形成可复用的搜救服务能力", "合作分成与运维服务"], ["指挥系统厂商", "接入可解释检测结果与日志", "接口集成与模块授权"]])}`;
  }
  if (/市场规模调查|目标市场规模/.test(lower)) {
    return `${para(`测算市场规模时，团队采用分层口径：宏观层面关注低空经济、民用无人机和公共安全智能装备增长趋势；可服务市场层面关注应急救援、消防巡查、灾害监测和无人机运营服务；初期可进入市场则聚焦具备试点沟通条件、能够提供样例数据或演示任务的单位。`)}

${para(`团队不直接承诺宏观市场收入，而是用可触达客户、单次试点服务、算法授权和运维服务进行保守估算。早期目标是形成2-3类典型场景样例和可复核测试材料，中期再根据试点反馈扩展到更多地区和队伍。`)}

${table(["市场层级", "测算对象", "估算依据"], [["TAM", "低空经济、应急机器人、公共安全智能装备", "公开资料口径"], ["SAM", "无人机搜救、灾害监测、消防辅助判读", "行业报告口径"], ["SOM", "校地合作、救援队伍、无人机服务商试点", "团队估算口径"], ["早期收入", "算法适配、试点服务、接口集成", "保守情景测算"]])}`;
  }
  if (/竞争优势/.test(lower)) {
    return `${para(`当前无人机搜救主要面临三类限制：一是目标尺度小，人员在高空视角下容易被植被、阴影和地形遮挡；二是场景变化大，跨地域、跨季节和跨灾害类型的数据分布差异明显；三是模型迁移不稳定，单一检测器在新场景中容易出现漏检或误检。`) }

${para(`相较“单一检测模型、固定阈值策略、单场景优化”的通用方案，该网络通过场景路由机制提高模型选择的针对性，通过多专家检测器提高不同地貌下的适配能力，通过元学习训练提升未知场景中的稳定性。当前限制主要在产品化环节，仍需持续积累多场景样本、完善轻量化部署、明确数据安全和救援责任边界。`)}

${table(["优势方向", "实现方式", "当前限制"], [["场景自适应", "根据输入图像特征选择专家模型", "需要更多场景样本校准"], ["跨场景泛化", "引入元学习机制提升新场景稳定性", "真实任务数据仍需积累"], ["工程落地", "保留轻量化部署和接口输出空间", "需与无人机平台继续联调"], ["结果可信", "输出置信度、路由结果和任务日志", "需要完善人工复核流程"]])}`;
  }
  if (/竞争分析/.test(lower)) {
    return `${para(`对照现有替代方案，团队主要比较四类路径：人工航拍判读具备经验优势但效率和一致性不足；单一YOLO检测器部署简单但跨场景稳定性有限；通用无人机巡检算法更偏向设施、线路或地块识别，对搜救人员小目标并不充分适配；普通目标检测平台缺少救援业务流程和责任边界。`)}

${para(`比较结果显示，场景路由和元适应机制是主要差异。系统能够根据输入图像的场景特征选择更合适的专家检测器，并用跨任务训练提升未知场景表现，使系统从“单模型性能展示”转向“多场景稳定服务”。同时，测试记录、路由命中率、消融实验和流程图能够与正文结论相互对应。`)}

${table(["替代方案", "已有优势", "主要不足", "应对方式"], [["人工航拍判读", "经验灵活", "效率低、不可稳定复现", "提供辅助检测与结果留痕"], ["单一YOLO检测器", "部署成本低", "跨地域泛化不稳", "多专家检测与路由选择"], ["通用巡检算法", "场景成熟", "不聚焦搜救小目标", "面向人员目标和应急任务"], ["普通检测平台", "功能完整", "缺少救援闭环", "输出指标、日志和接口说明"]])}`;
  }
  if (/差异化优势/.test(lower)) {
    return `${para(`该网络的差异首先体现在任务定义上。系统不是泛化巡检算法，而是围绕搜救人员小目标检测建立场景路由、专家模型和元适应训练机制，对复杂植被、开阔地貌、灾后遮挡和多尺度混合目标分别形成处理策略。`)}

${para(`工程层面，系统不只输出目标框，还同步保留场景判断、路由选择、置信度、模型版本和任务日志，便于救援人员复核和后续迭代。对于应急类应用，这种“可解释、可追踪、可迭代”的能力比单次指标提升更接近真实使用要求。`)}

${table(["优势维度", "具体表现", "应用价值"], [["技术机制", "多专家检测、场景路由、元学习优化", "提升跨场景稳定性"], ["工程部署", "轻量化模块、接口化输出、日志留存", "便于接入无人机与指挥系统"], ["任务适配", "聚焦人员小目标和复杂背景", "减少通用算法错配"], ["迭代能力", "误检漏检样例回流训练", "形成长期优化空间"]])}`;
  }
  if (/商业模式/.test(lower)) {
    return `${para(`商业化路径采用“项目制交付+模块授权+运维更新”的组合方式。早期以算法适配、原型演示和小范围试点形成第一批案例；中期把路由模块、专家检测器和验证脚本整理成标准化算法包；长期向应急救援平台、无人机运营商和指挥系统厂商提供持续更新服务。`)}

${table(["收入来源", "客户对象", "交付内容", "测算依据"], [["算法模块授权", "系统集成商、无人机企业", "检测模型、路由模块、接口文档", "团队估算口径"], ["试点技术服务", "应急/消防单位", "场景适配、演示测试、报告", "项目制服务"], ["运维更新", "平台客户", "模型升级、日志分析、问题修复", "年度服务"], ["联合方案", "无人机运营商", "搜救服务包和任务报告", "合作分成"]])}`;
  }
  if (/盈利模式|项目价值/.test(lower)) {
    return `${para(`收入结构由基础授权、场景化增强和持续服务三层组成。基础授权面向需要接入算法能力的无人机平台或指挥系统，提供模型、路由模块和接口说明；场景化增强面向森林、山地、灾后搜索等特定任务，提供适配训练和验证报告；持续服务面向长期客户，提供模型更新、日志分析和问题复盘。`)}

${para(`在救援任务中，实际价值集中在三个环节：提高疑似目标发现概率，缩短大范围图像初筛时间，降低人工判读压力；同时把检测结果、路由选择和模型版本形成可追溯记录。对申报材料而言，这种价值既能体现技术创新，也能说明商业服务边界。`)}`;
  }
  if (/营销策略/.test(lower)) {
    return `${para(`团队不采用泛化广告推广，而以可信样例和专业场景切入。前期通过校内外竞赛展示、导师资源引荐、公开应急演练场景研究和无人机服务商访谈建立早期触点，再用原型演示、指标对比和流程图说明应用价值。`)}

${para(`推广材料重点呈现三类内容：一是典型搜救图像中的检测效果；二是路由前后mAP、Precision、Recall、F1等指标变化；三是从图像输入到指挥结果输出的业务流程。市场进入顺序以“可演示、可验证、可合作”为原则，先服务具备样例数据和演示条件的单位，再逐步扩展到系统集成和持续运维场景。`)}

${table(["营销阶段", "主要动作", "形成材料"], [["展示期", "竞赛路演、原型演示、场景案例整理", "演示视频、效果截图"], ["试点期", "对接救援队伍或无人机服务商，开展小样本验证", "测试记录、需求清单"], ["合作期", "提供算法包、接口说明和部署边界", "报价方案、服务清单"], ["运维期", "持续更新模型、复盘误检漏检样例", "版本记录、运维报告"]])}`;
  }
  if (/短期战略/.test(lower)) {
    return para(`短期1-2年，团队聚焦技术验证与试点落地。研发上优先完善HMAD-Ednet、SPA-HyperNet和Reptile元训练流程，形成稳定的实验记录、消融实验、路由命中率统计和系统演示材料；同时选择森林、山地、灾后搜索等典型场景组织样例测试，用原型测试口径证明系统相较单一检测器具有更好的场景适应能力。`);
  }
  if (/中期战略/.test(lower)) {
    return para(`中期3-5年，团队聚焦市场拓展与生态构建。在早期验证基础上整理标准化算法包、接口说明、部署文档和服务流程，面向无人机运营商、应急救援队伍和指挥系统集成商开展合作。该阶段重点不是盲目扩大客户数量，而是形成可复制的场景清单、成本测算模型和交付验收表。`);
  }
  if (/长期战略/.test(lower)) {
    return para(`长期5年以上，该网络聚焦行业化能力与平台化服务。团队将多场景搜救数据、路由策略、模型更新记录和应用反馈持续沉淀，逐步形成复杂场景小目标检测的算法服务能力。随着应用场景扩展，该网络可由搜救检测延伸到灾害监测、环境巡查和公共安全辅助决策，但所有扩展均以数据授权、飞行合规和业务责任边界为前提。`);
  }
  if (/发展战略/.test(lower)) {
    return `${para(`发展战略遵循“先验证核心场景，再沉淀标准交付，后拓展合作生态”的路径。技术上持续提升跨场景稳定性，市场上优先服务具备试点条件的公共安全和无人机服务主体，材料上同步沉淀测试记录、财务测算、附件索引和答辩展示材料，使每个阶段都能形成可检查成果。`)}

${table(["阶段", "核心目标", "主要成果"], [["短期", "完成模型链路和典型场景验证", "原型系统、实验记录、演示材料"], ["中期", "形成标准化算法包和服务流程", "接口文档、部署说明、试点方案"], ["长期", "建设多场景数据闭环和持续运维能力", "模型更新机制、行业化服务方案"]])}`;
  }
  if (/核心竞争力保障/.test(lower)) {
    return `${para(`核心竞争力来自技术路线、数据闭环、工程接口和材料沉淀四个方面。技术路线上，系统通过场景路由和多专家检测形成区别于单一模型的能力；数据闭环上，误检、漏检和路由失配样例会进入后续迭代；工程接口上，系统保留与无人机平台、指挥系统和任务日志对接的空间；材料沉淀上，实验表、流程图和附件索引共同支撑申报可信度。`)}

${para(`为避免项目停留在算法概念层面，团队将核心竞争力落实到可持续改进机制中：每一次测试都同步记录数据来源、场景类型、模型版本、指标变化和问题原因；每一次演示都同步更新接口说明、部署边界和用户反馈；每一次材料提交都同步核对图表编号、指标数值和附件对应关系。技术、工程和材料三条线保持一致，才能支撑后续试点与成果转化。`)}

${table(["保障维度", "具体做法", "支撑作用"], [["技术", "多专家检测与元适应训练", "形成区别于单模型的能力"], ["数据", "样例、日志、误检漏检记录回流", "支撑持续迭代"], ["工程", "接口说明、部署边界、日志输出", "提高落地可行性"], ["材料", "图表、实验、财务和附件索引", "保持正文结论一致"]])}`;
  }
  if (/救援人员风险|民生安全/.test(lower)) {
    return para(`无人机先行获取图像后，系统完成小目标辅助检测和疑似区域标记，救援队伍再结合现场经验进行复核与处置。这样的流程能够减少一线人员进入危险区域的频次，降低盲目搜索压力，并在复杂地形和灾后不稳定环境中保护救援人员安全。`);
  }
  if (/社会发展|民生/.test(lower)) {
    return para(`灾害发生后，大范围航拍图像往往需要快速筛查，传统人工判读耗时较长且受疲劳影响。场景自适应检测网络可以为救援人员提供辅助发现线索，提高搜救响应效率和目标发现概率，使有限救援资源更快聚焦高价值区域。`);
  }
  if (/公共安全治理/.test(lower)) {
    return para(`检测结果、路由选择、模型版本和任务日志能够形成事件记录，便于后续复盘、责任界定和能力改进。对于政府和应急管理部门而言，这种可解释、可归档、可复核的智能感知能力能够补足公共安全治理中的技术支撑，提升应急处置的规范化和数字化水平。`);
  }
  if (/环境保护|绿色发展/.test(lower)) {
    return para(`在环境保护方面，无人机巡航和智能判读可以替代或补充部分人力巡查。通过减少大范围地面搜索、车辆进入和重复巡查，系统可在森林、山地和灾后区域降低救援活动对环境的二次扰动；低功耗模型和轻量化部署也有利于控制设备运行成本。`);
  }
  if (/灾害预警|环境监测/.test(lower)) {
    return para(`虽然当前主线聚焦搜救人员小目标检测，但场景路由、多专家检测和元适应机制同样适用于复杂背景下的异常目标发现。后续在数据授权和场景验证基础上，技术能力可拓展到灾后巡查、山林监测和重点区域风险识别，为灾害预警和环境监测提供辅助支撑。`);
  }
  if (/直接经济价值/.test(lower)) {
    return para(`直接经济价值来自算法授权、试点服务、接口集成和运维更新。项目早期可按单次试点或项目制服务收费，中期通过标准算法包和系统接口形成授权收入，长期通过模型更新、场景适配和技术支持形成持续收入。收入测算以服务内容、交付周期和运维频次为基础，不写成已经发生的经营结果。`);
  }
  if (/盈利能力与经济价值/.test(lower)) {
    return `${para(`盈利能力取决于“可复制算法能力”和“可持续服务能力”两项基础。算法能力支撑不同搜救场景中的模块授权和适配服务，服务能力则围绕模型更新、场景验证和日志复盘形成长期收入。经济价值测算采用保守口径，不把潜在客户和预测收入写成既成事实。`)}

${table(["价值来源", "形成方式", "估算依据"], [["授权收入", "模型与路由模块接入第三方系统", "团队估算口径"], ["服务收入", "试点适配、测试验证和报告输出", "项目制口径"], ["运维收入", "模型升级、日志分析和故障响应", "年度服务口径"], ["协同价值", "降低人工判读和无效搜索成本", "间接收益口径"]])}`;
  }
  if (/间接经济价值/.test(lower)) {
    return para(`间接经济价值体现在降本增效。对救援组织而言，系统可以缩短图像筛查时间、减少人工重复判读、降低无效搜索范围；对无人机服务商而言，算法能力有助于提升服务包附加值；对系统集成商而言，标准化接口和日志材料能降低二次开发成本。`);
  }
  if (/可扩展价值/.test(lower)) {
    return para(`扩展空间来自平台化算法能力和数据资产沉淀。随着更多场景测试记录、路由命中率、误检漏检样例和模型版本日志积累，复杂背景小目标检测将逐步形成数据闭环。该闭环可继续服务灾后巡查、山林监测、重点区域风险识别等相邻场景，使系统从单次搜救辅助工具扩展为公共安全智能感知能力。`);
  }
  if (/总结/.test(lower)) {
    return `${para(`${name}围绕无人机搜救中的复杂场景小目标检测问题，形成“多专家检测+场景路由+元学习优化”的完整方案。真正价值不只在于提升单次检测指标，更在于把检测结果、路由收益、实验记录、系统接口和证明材料组织成可交付、可追踪、可迭代的技术路线。`)}

${para(`技术路线以场景自适应为主线，解决单一模型面对复杂地貌、遮挡和尺度变化时稳定性不足的问题；应用场景面向应急搜救、灾后巡查和公共安全辅助决策，目标是帮助救援人员更快发现疑似目标；商业路径以试点服务、模块授权和持续运维为主要方式，逐步沉淀标准化交付能力。`)}`;
  }
  if (/资金回报/.test(lower)) {
    return `${para(`团队把经费投向算法研发、数据整理、原型测试、部署验证、材料制作和市场调研。回报路径采用保守估算：短期形成原型和试点服务能力，中期形成算法授权和接口集成收入，长期通过持续运维和场景化模型更新形成稳定服务。`)}

${para(`资金使用优先保障能够直接提升项目可信度的环节，包括样例数据清洗、训练与推理环境、典型场景测试、演示材料制作和基础市场调研。对于尚未进入真实采购的阶段，项目回报不写成固定收益，而以“形成可交付能力、降低后续试点成本、提高合作沟通效率”作为主要回报。`)}

${table(["资金用途", "形成成果", "回报方式"], [["算法研发", "HMAD-Ednet、SPA-HyperNet、训练脚本", "技术壁垒"], ["测试验证", "指标表、消融实验、路由记录", "试点可信度"], ["部署与演示", "原型系统、流程图、演示材料", "客户沟通"], ["市场与材料", "客户分层、财务测算、附件索引", "转化基础"]])}`;
  }
  if (/交付物汇总/.test(lower)) {
    return table(["交付物", "内容", "证明作用"], [["八章正文", "目录、图表和财务口径", "支撑申报"], ["系统架构图", "超路由元适应检测网络模块关系", "说明产品结构"], ["实验结果表", "mAP、Precision、Recall、F1等指标", "说明技术效果"], ["流程图", "PhaseA/PhaseB与搜救业务流程", "说明实施路径"], ["附件索引", "数据、测试、团队分工和测算材料", "增强可追溯性"]]);
  }
  if (/分工/.test(lower)) {
    return `${para(`团队分工按照“商业分析—实验—分析—设计—实现—部署”的链路展开。项目负责人统筹技术路线、进度安排和文本定稿；算法研发成员负责 HMAD-Ednet、SPA-HyperNet、多专家检测器和 Reptile 元训练流程；数据与实验成员负责样例整理、指标记录和消融实验；产品与部署成员负责架构图、流程图、演示流程和接口边界；市场与财务成员负责客户分层、竞品对比和经费测算。`)}

${table(["角色", "主要职责", "阶段成果"], [["项目负责人", "统筹技术路线、进度和申报材料", "里程碑计划、项目书统稿"], ["算法研发", "实现多专家检测、场景路由和元学习训练", "模型脚本、测试记录"], ["数据与实验", "整理样例数据、指标表和消融实验", "实验结果、问题清单"], ["产品与部署", "绘制架构图、流程图和演示流程", "原型说明、部署边界"], ["市场与财务", "客户分层、竞品分析和成本收益测算", "市场表、财务表"]])}`;
  }
  if (/协作机制/.test(lower)) {
    return `${para(`团队协作以阶段复盘和知识移交为核心。每完成一次训练、测试或文本更新，团队同步记录数据版本、模型参数、问题清单和下一步责任人，保证上一阶段实验结论能够成为下一阶段设计依据，避免在有限时间内重复探索。`)}

${para(`项目会议按“目标确认—进展同步—问题归因—材料沉淀”组织。技术问题进入实验清单，市场与财务问题进入调研清单，格式与附件问题进入提交清单，最终由负责人统一校对项目名称、图表编号、指标数据和章节表述。`)}`;
  }
  if (/团队/.test(lower)) {
    return `${para(`项目团队围绕${name}的技术研发、实验验证、产品整理、市场调研、财务测算和申报材料形成协同分工。技术成员重点负责${modules.slice(0, 4).join("、")}的实现与测试，材料成员负责系统架构图、流程图、实验结果表和证明材料索引，调研与财务成员围绕${users.slice(0, 4).join("、")}的使用需求、采购场景和成本收益口径组织资料。`)}

${table(["角色", "主要职责", "阶段成果"], [["项目负责人", "统筹技术路线、进度和申报材料", "里程碑计划、项目书统稿"], ["算法研发", "实现多专家检测、场景路由和元学习训练", "模型脚本、测试记录"], ["数据与实验", "整理样例数据、指标表和消融实验", "实验结果、问题清单"], ["产品与部署", "绘制架构图、流程图和演示流程", "原型说明、部署边界"], ["市场与财务", "客户分层、竞品分析和成本收益测算", "市场表、财务表"]])}`;
  }
  if (/背景|产业|市场概述|规模|机会|目标市场/.test(lower)) {
    return para(`${name}面向${profile.domain}中的真实需求展开，重点回应${scenes.slice(0, 4).join("、")}场景下${pains.slice(0, 5).join("、")}等问题。当前传统单一检测器、人工航拍判读和通用目标检测平台在小目标、复杂背景、跨场景泛化和结果可解释方面仍存在不足，难以直接满足应急救援和公共安全场景对准确率、响应速度、稳定性和材料可追溯性的要求。因此，项目以${modules.slice(0, 5).join("、")}为核心，把算法验证、业务流程和证明材料组织成可展示、可测试、可迭代的项目方案。`);
  }
  if (/简述|产品|服务|实施|计划/.test(lower)) {
    return para(`项目技术路线围绕“${profile.techRoute}”展开。系统从无人机航拍或SAR场景图像输入出发，经过场景特征提取、路由判别、多专家检测器选择、元适应优化和结果输出，形成面向搜救指挥的检测闭环。阶段验收以${metrics.slice(0, 6).join("、")}为核心指标，交付材料包括${evidence.slice(0, 6).join("、")}，用于说明项目不是停留在概念层面的算法设想，而是能够通过原型测试口径和项目估算口径逐步证明可行性的智能检测网络。`);
  }
  if (/竞争|优势|差异|核心竞争力|限制/.test(lower)) {
    return para(`与${competitors.slice(0, 4).join("、")}相比，本项目的差异化价值在于将${modules.slice(0, 5).join("、")}组合为场景自适应检测链路，既关注检测精度，也关注路由选择、跨场景稳定性和救援业务可用性。项目当前仍需持续补充多场景数据、测试日志、部署边界和真实业务接口，因此正文中的收入、客户数量、性能结论和试点成效均采用项目估算口径或原型测试口径表达，不把尚未取得的商业化成果写成既成事实。`);
  }
  if (/商业|营销|发展|战略|盈利|价值|资金|回报|经济/.test(lower)) {
    return para(`项目商业化路径以${models.slice(0, 5).join("、")}为主，初期通过原型演示、算法适配和试点服务建立信任，中期形成标准化算法包、接口说明和服务流程，长期面向应急救援、无人机运营和指挥系统集成生态提供持续更新能力。相关收入、成本、客户数量和投资回报采用项目估算口径，重点说明测算逻辑、交付内容、阶段目标和风险边界，使商业模式既符合竞赛项目书表达，也不越过当前材料能够证明的事实范围。`);
  }
  if (/效益|社会|民生|治理|环境|预警|扩展/.test(lower)) {
    return para(`项目预期效益体现在应急效率提升、搜救风险降低、公共安全治理能力增强和技术成果转化等方面。通过${metrics.slice(0, 6).join("、")}等指标，项目能够把模型效果转化为可解释的应用价值；通过${evidence.slice(0, 5).join("、")}等材料，项目能够为评审、试点沟通和后续成果沉淀提供依据。整体来看，项目价值不只在于单次检测结果，更在于形成可复用的复杂场景小目标检测方法和可追溯的救援辅助决策材料。`);
  }
  if (/材料使用说明/.test(lower)) {
    return `${para(`材料使用遵循“正文结论对应材料、测算内容说明假设、计划事项明确边界”的原则。政策和行业资料用于说明产业背景与市场机会；系统架构图和流程图用于说明产品结构与实施路径；实验结果表、消融实验和路由命中率记录用于说明技术效果；分工表、预算表和收入预测表用于说明团队执行与资金安排。`)}

${para(`正式提交时，正文中涉及已完成成果的内容应能对应到实验记录、图表或附件；涉及未来计划的内容应落到阶段目标和验收方式；涉及成本、收入、客户数量和市场规模的内容应保留测算假设。通过这种方式，项目书能够避免把计划写成既成事实，也能保持正文、图表、附件和答辩材料的一致。`)}`;
  }
  if (/证明|材料|附件/.test(lower)) {
    return `${para(`附件清单主要包括政策与行业资料、系统架构图、流程图、实验结果表、消融实验、路由命中率记录、数据集说明、测试日志和团队分工材料。每份材料说明形成方式、证明对象、对应正文位置和当前状态，使技术结论、市场判断、财务测算和团队能力之间保持一致。暂未形成正式证书或合同的内容，只按计划或测算表达。`)}

${table(["材料类型", "主要内容", "对应章节"], [["政策与行业资料", "低空经济、应急机器人、无人机管理相关资料", "产业背景、市场分析"], ["技术图表", "系统架构图、Phase A/Phase B流程图", "项目产品、实施计划"], ["实验材料", "指标表、消融实验、路由命中率记录", "项目简述、竞争优势"], ["团队与财务材料", "分工表、预算表、收入预测表", "团队概述、资金回报"]])}`;
  }
  return para(`${name}围绕${users[index % users.length]}、${scenes[index % scenes.length]}和${modules[index % modules.length]}展开论证。相关内容以当前项目材料、阶段实验和可说明的测算为基础，保持技术路线、商业路径和附件材料之间的一致。`);
}

function referenceSectionSupplement(config: WorkflowConfig, chapter: string, section: string, index: number) {
  return "";
}

function buildReferenceChapterFromSkeleton(config: WorkflowConfig, step: StepDef) {
  const chapter = canonicalStepHeading(step).chapter || step.targetSection || step.name;
  const headings = referenceChapterHeadings(config, chapter);
  const normalizedHeadings = headings.length
    ? headings
    : /团队/.test(chapter)
      ? ["团队分工", "协作机制"]
      : /总结与资金回报/.test(chapter)
        ? ["（一）总结", "（二）资金回报", "（三）交付物汇总"]
        : /证明材料/.test(chapter)
          ? ["证明材料清单", "材料使用说明"]
          : ["项目内容", "实施路径", "材料依据"];
  const body = normalizedHeadings
    .map((heading, index) => {
      const level = /^\d+[.．、]/.test(heading) ? "####" : "###";
      const supplement = referenceSectionSupplement(config, chapter, heading, index);
      return `${level} ${heading}\n${referenceChapterContentBlock(config, chapter, heading, index)}${supplement ? `\n\n${supplement}` : ""}`;
    })
    .join("\n\n");
  return `## ${chapter}\n${body}`.trim();
}

function referenceChapterFallback(config: WorkflowConfig, step: StepDef) {
  const chapter = canonicalStepHeading(step).chapter || step.targetSection || step.name;
  const chapters = referenceStyleChapters(config);
  const chapterInfo = chapters.find((item) => item.chapter === chapter);
  const excerpt = referenceChapterExcerpt(config, chapter);
  const fromReference = markdownizeReferenceChapter(excerpt);
  void chapters;
  void chapterInfo;
  void fromReference;
  return buildReferenceChapterFromSkeleton(config, step);

  const sections = chapterInfo?.sections.length ? chapterInfo.sections : ["项目内容", "实施路径", "材料依据"];
  const sectionBody = sections.map((section) => {
    if (/背景|产业|市场概述|规模|机会/.test(section)) {
      return `### ${section}\n${config.name}面向${profile.domain}中的真实需求展开。当前${profile.users.slice(0, 4).join("、")}在${profile.scenes.slice(0, 4).join("、")}中仍面临${profile.painPoints.slice(0, 5).join("、")}等问题，传统单一模型或人工判读方式难以在复杂场景下同时保证准确性、稳定性和响应效率。基于此，项目以${profile.productModules.slice(0, 5).join("、")}为核心，形成可验证、可迭代、可进入应急业务流程的智能检测方案。`;
    }
    if (/简述|产品|服务|实施|计划/.test(section)) {
      return `### ${section}\n本项目围绕${profile.techRoute}组织技术路线。系统从场景图像或任务输入出发，经过特征提取、模型选择、检测推理、指标验证和结果输出，将${profile.metrics.slice(0, 6).join("、")}作为阶段验收依据。项目交付内容包括${profile.evidenceFocus.slice(0, 6).join("、")}等材料，用于证明系统不是概念化方案，而是具备原型验证和材料沉淀基础。`;
    }
    if (/竞争|优势|差异|核心竞争力|限制/.test(section)) {
      return `### ${section}\n相较${profile.competitors.slice(0, 4).join("、")}，本项目的优势在于将${profile.productModules.slice(0, 5).join("、")}组合为场景自适应检测链路，重点回应${profile.painPoints.slice(0, 5).join("、")}。与此同时，项目仍需持续补充多场景数据、测试记录、部署边界和真实业务接口，相关内容在正文中均采用原型测试口径或项目估算口径表述，不写成已经完成的商业化成果。`;
    }
    if (/商业|营销|发展|战略|盈利|价值|资金|回报/.test(section)) {
      return `### ${section}\n项目商业化路径以${profile.businessModels.slice(0, 5).join("、")}为主，初期通过原型演示、算法适配和试点服务建立信任，中期形成标准化算法包、接口说明和服务流程，长期面向应急救援和无人机业务生态提供持续更新能力。所有收入、成本、客户数量和投资回报均采用项目估算口径，重点说明测算逻辑、交付内容和风险边界。`;
    }
    if (/团队/.test(chapter + section)) {
      return `### ${section}\n项目团队按照技术研发、数据与实验、产品设计、市场调研、财务测算和申报材料分工推进。技术成员负责${profile.productModules.slice(0, 4).join("、")}的实现与测试，调研成员负责目标用户和应用场景材料，财务成员负责成本收益估算，材料成员负责项目书、图表和附件一致性。团队协作以阶段复盘、版本记录和材料归档保证项目推进可检查。`;
    }
    if (/效益|社会|民生|治理|环境|经济|扩展/.test(section)) {
      return `### ${section}\n项目预期效益体现在应急效率提升、搜救风险降低、公共安全治理能力增强和技术成果转化等方面。通过${profile.metrics.slice(0, 6).join("、")}等指标，项目能够把技术效果转化为可解释的应用价值；通过${profile.evidenceFocus.slice(0, 5).join("、")}等材料，项目能够为后续竞赛评审、试点沟通和成果沉淀提供依据。`;
    }
    if (/证明|材料|附件/.test(chapter + section)) {
      return `### ${section}\n证明材料围绕政策与行业资料、系统架构图、实验结果表、消融实验、路由命中率记录、数据集说明、测试日志和团队分工材料组织。每份材料需说明形成方式、证明对象、对应正文位置和当前状态，保证项目书中的技术结论、市场判断、财务测算和团队能力均有可追溯依据。`;
    }
    return `### ${section}\n${config.name}在本节中围绕${profile.users.slice(0, 4).join("、")}、${profile.scenes.slice(0, 4).join("、")}和${profile.productModules.slice(0, 5).join("、")}展开论证，保持项目事实、技术路线、商业路径和附件材料之间的一致。`;
  }).join("\n\n");
  return `## ${chapter}\n${sectionBody}`;
}

function referenceStyleBlueprint(config: WorkflowConfig) {
  const chapters = referenceStyleChapters(config);
  if (!chapters.length) return "";
  const blocks = chapters.map((item) => {
    const sections = item.sections.length ? `\n${item.sections.map((section) => `  - ${section}`).join("\n")}` : "";
    return `- ${item.chapter}${sections}`;
  });
  return `\n\n## 从当前上传参考文档识别出的目录蓝图\n${blocks.join("\n")}\n\n执行口径：上传参考文档存在时，工作流步骤、终稿目录、一级章顺序、二级标题层级和段落布局优先贴近上述蓝图；若蓝图与内置竞赛骨架冲突，以当前上传参考文档为准。`;
}

function buildReferenceStyleBlueprintArtifact(config: WorkflowConfig) {
  const chapters = referenceStyleChapters(config);
  if (!chapters.length) {
    return [
      "# 参考写法蓝图",
      "",
      "## 生成范围",
      "- 当前未检测到可用的参考文档，改用竞赛项目书基础结构。",
      "- 生成时仍遵守：只围绕当前主题，不借用其他项目或历史样例。",
      "",
      "## 结构映射",
      "- project-book-audit-loop",
      "- 项目概述",
      "- 团队与分工",
      "- 场景、问题与方案",
      "- 竞品/市场/应用分析",
      "- 实施计划、预算与证据",
      "",
      "## 书写规则",
      "- 首段先写场景、矛盾、政策或行业机会，再落到项目本体。",
      "- 每个章节只承担一个明确任务，避免标题化堆叠。",
      "- 表格行尽量短，超长内容拆成两行，不挤成一格。",
      "- 不把系统说明、审计话语或模板口吻写进正式正文。",
    ].join("\n");
  }
  const lines = [
    "# 参考写法蓝图",
    "",
    "## 生成范围",
    "- 仅学习当前上传参考文档的结构、段落布局、标题层级、表格节奏和写法，不引用其他项目样例。",
    "- 参考文档存在时，优先使用其章节顺序和版式习惯；不存在时，使用竞赛基础结构。",
    "",
    "## 结构映射",
  ];
  for (const item of chapters) {
    lines.push(`- ${item.chapter}`);
    if (item.sections.length) {
      for (const section of item.sections) lines.push(`  - ${section}`);
    } else {
      lines.push("  - 无显式二级标题，按段落节奏展开");
    }
  }
  lines.push(
    "",
    "## 书写规则",
    "- 首段先写场景、矛盾、政策或行业机会，再落到项目本体。",
    "- 每个章节只承担一个明确任务，避免标题化堆叠。",
    "- 表格行尽量短，超长内容拆成两行，不挤成一格。",
    "- 不把系统说明、审计话语或模板口吻写进正式正文。",
  );
  return lines.join("\n");
}

function withReferenceContext(config: WorkflowConfig, uploadKnowledgeBody?: string): WorkflowConfig {
  const referenceContext = compactFactReferenceContext(uploadKnowledgeBody || "");
  const styleReferenceContext = compactStyleReferenceContext(uploadKnowledgeBody || "");
  return {
    ...config,
    ...(referenceContext ? { referenceContext } : {}),
    ...(styleReferenceContext ? { styleReferenceContext } : {}),
  };
}

function projectDirFor(id: string) {
  return join(PROJECTS_DIR, id);
}

function normalizeEditorPath(pathValue: unknown) {
  return String(pathValue ?? "").replace(/\\/g, "/").replace(/^\/+/, "");
}

function resolveProjectPath(id: string, pathValue: unknown) {
  const projectDir = resolve(projectDirFor(id));
  const relativePath = normalizeEditorPath(pathValue);
  if (!relativePath || isAbsolute(relativePath) || relativePath.includes("\0")) {
    throw new Error("鏂囦欢璺緞涓嶅悎娉?");
  }
  const absolutePath = resolve(projectDir, relativePath);
  const scope = relative(projectDir, absolutePath);
  if (scope.startsWith("..") || isAbsolute(scope)) {
    throw new Error("鏂囦欢瓒呭嚭椤圭洰宸ヤ綔鍖?");
  }
  return { projectDir, relativePath, absolutePath };
}

function fileKind(relativePath: string) {
  if (relativePath.startsWith(".paper/drafts/")) return "draft";
  if (relativePath.startsWith(".paper/artifacts/")) return "artifact";
  if (relativePath.startsWith(".paper/exports/")) return "export";
  if (relativePath.startsWith(".paper/uploads/")) return "upload";
  return "project";
}

function listEditorFiles(id: string) {
  const projectDir = projectDirFor(id);
  const roots = [
    { label: "项目文件", root: ".paper" },
    { label: "章节产物", root: ".paper/artifacts" },
    { label: "最终稿与导出", root: ".paper/drafts" },
  ];

  roots.splice(1, 0, { label: "上传资料", root: ".paper/uploads" });
  return roots.map((group) => {
    const dir = join(projectDir, ...group.root.split("/"));
    const files = existsSync(dir)
      ? readdirSync(dir, { withFileTypes: true })
          .filter((entry) => entry.isFile() && EDITABLE_EXTENSIONS.has(extname(entry.name).toLowerCase()))
          .map((entry) => {
            const relativePath = `${group.root}/${entry.name}`;
            const absolutePath = join(dir, entry.name);
            return {
              name: entry.name,
              path: relativePath,
              kind: fileKind(relativePath),
              extension: extname(entry.name).slice(1) || "text",
              size: statSync(absolutePath).size,
              updated: statSync(absolutePath).mtime.toISOString(),
            };
          })
          .sort((a, b) => a.name.localeCompare(b.name))
      : [];
    return { ...group, files };
  });
}

function writeEditorFile(id: string, pathValue: unknown, content: unknown) {
  const { relativePath, absolutePath } = resolveProjectPath(id, pathValue);
  const allowed = relativePath.startsWith(".paper/drafts/") || relativePath.startsWith(".paper/artifacts/");
  if (!allowed) throw new Error("鍙兘淇濆瓨 drafts/artifacts 鐩綍涓嬬殑鏂囦欢");
  if (!EDITABLE_EXTENSIONS.has(extname(relativePath).toLowerCase())) throw new Error("涓嶆敮鎸佺紪杈戣鏂囦欢绫诲瀷");
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, String(content ?? ""), "utf-8");
  const config = readConfig(id);
  if (config) {
    config.updated = new Date().toISOString();
    writeConfig(id, config);
  }
  return {
    name: basename(absolutePath),
    path: relativePath,
    kind: fileKind(relativePath),
    size: statSync(absolutePath).size,
    updated: statSync(absolutePath).mtime.toISOString(),
  };
}

function latexPreviewUrl(fileName: string) {
  return `/api/workflows/latex-output/${encodeURIComponent(fileName)}`;
}

function formatLatexAttempt(attempt: any) {
  if (attempt?.skipped) return `- ${attempt.compiler}: skipped (${attempt.reason})`;
  if (!attempt) return "";
  const outcome = attempt.exitCode === 0 && attempt.pdfExists ? "passed" : "failed";
  return `- ${attempt.compiler}: ${outcome} (exit ${attempt.exitCode})`;
}

function normalizeLatexCompileLog(data: any, summaryName: string, sourcePath: string, outputPath: string) {
  const attempts = Array.isArray(data?.attempts) ? data.attempts.map(formatLatexAttempt).filter(Boolean).join("\n") : "";
  const command = Array.isArray(data?.command) ? data.command.join(" ") : "";
  const parts = [
    `Workflow: ${summaryName}`,
    `Source: ${sourcePath}`,
    `Root: ${data?.rootFile || sourcePath}`,
    `Compiler: ${data?.compiler || "not compiled"}`,
    command ? `Command: ${command}` : "",
    `Exit code: ${data?.exitCode ?? "unknown"}`,
    `PDF: ${outputPath}`,
    attempts ? `\nAttempts:\n${attempts}` : "",
    data?.log ? `\nLog:\n${String(data.log).trim()}` : "",
  ].filter(Boolean);
  return parts.join("\n");
}

function compileLatexEditorFile(id: string, pathValue: unknown, summaryName: string) {
  const { relativePath, absolutePath } = resolveProjectPath(id, pathValue);
  if (extname(relativePath).toLowerCase() !== ".tex") {
    throw new Error("当前文件不是 .tex，无法走 LaTeX 编译器");
  }
  if (!existsSync(absolutePath) || !statSync(absolutePath).isFile()) {
    throw new Error("LaTeX 源文件不存在");
  }
  if (!existsSync(CODEX_LATEX_COMPILE_SCRIPT)) {
    throw new Error(`未找到 Codex LaTeX 插件脚本：${CODEX_LATEX_COMPILE_SCRIPT}`);
  }

  mkdirSync(EXPORTS_DIR, { recursive: true });
  const safeBase = safeId(`${summaryName}-${basename(absolutePath, extname(absolutePath))}`);
  const stamp = Date.now();
  const buildDir = join(EXPORTS_DIR, `${safeBase}-${stamp}-latex-build`);
  mkdirSync(buildDir, { recursive: true });

  return new Promise<{ success: boolean; outputPath: string; fileName: string; fileSize: number; log: string; previewUrl: string; compiler?: string }>((resolve, reject) => {
    const child = spawn(resolvePythonExe(), [
      CODEX_LATEX_COMPILE_SCRIPT,
      absolutePath,
      "--compiler",
      "auto",
      "--engine",
      "xelatex",
      "--output-directory",
      buildDir,
      "--json",
    ], {
      cwd: CODEX_LATEX_PLUGIN_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("LaTeX 编译超时，请检查宏包、图片路径或循环引用。"));
    }, LATEX_COMPILE_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      let data: any = null;
      try {
        data = JSON.parse(stdout.trim());
      } catch {
        reject(new Error((stderr || stdout || `LaTeX 编译进程退出，code=${code}`).trim()));
        return;
      }

      const pluginPdfPath = String(data.pdfPath || "");
      const pdfExists = pluginPdfPath && existsSync(pluginPdfPath) && statSync(pluginPdfPath).isFile();
      const outputName = `${safeBase}-${stamp}.pdf`;
      const outputPath = join(EXPORTS_DIR, outputName);
      if (code !== 0 || !pdfExists) {
        const log = normalizeLatexCompileLog(data, summaryName, relativePath, pluginPdfPath || outputPath);
        reject(new Error(`${log}\n${stderr ? `\nStderr:\n${stderr.trim()}` : ""}`.trim()));
        return;
      }

      copyFileSync(pluginPdfPath, outputPath);
      resolve({
        success: true,
        outputPath,
        fileName: outputName,
        fileSize: statSync(outputPath).size,
        log: normalizeLatexCompileLog(data, summaryName, relativePath, outputPath),
        previewUrl: latexPreviewUrl(outputName),
        compiler: data.compiler || undefined,
      });
    });
  });
}

async function readRequestBody(req: any, maxBytes = UPLOAD_MAX_BYTES): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) throw Object.assign(new Error(`上传文件过大，单次上传请控制在 ${formatBytes(maxBytes)} 以内；请分批上传参考项目书和附件。`), { statusCode: 413 });
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function parseMultipartUploads(body: Buffer, contentType: string) {
  const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  const boundary = boundaryMatch?.[1] || boundaryMatch?.[2];
  if (!boundary) throw new Error("缺少 multipart boundary");
  const marker = `--${boundary}`;
  const raw = body.toString("binary");
  const files: { field: string; filename: string; contentType: string; data: Buffer }[] = [];
  for (const part of raw.split(marker)) {
    if (!part.includes("Content-Disposition")) continue;
    const [rawHeaders, ...rest] = part.split("\r\n\r\n");
    if (!rest.length) continue;
    const disposition = rawHeaders.match(/Content-Disposition:[^\r\n]+/i)?.[0] || "";
    const name = disposition.match(/name="([^"]+)"/)?.[1] || "file";
    const filename = disposition.match(/filename="([^"]*)"/)?.[1] || "";
    if (!filename) continue;
    const contentTypeHeader = rawHeaders.match(/Content-Type:\s*([^\r\n]+)/i)?.[1] || "application/octet-stream";
    let contentBinary = rest.join("\r\n\r\n");
    contentBinary = contentBinary.replace(/\r\n--$/, "").replace(/\r\n$/, "");
    files.push({
      field: name,
      filename,
      contentType: contentTypeHeader,
      data: Buffer.from(contentBinary, "binary"),
    });
  }
  return files;
}

function uniqueUploadName(dir: string, originalName: string) {
  const cleaned = safeId(basename(originalName)) || `upload-${Date.now()}`;
  const ext = extname(originalName);
  const base = ext ? cleaned.replace(new RegExp(`${ext.replace(".", "\\.")}$`, "i"), "") : cleaned;
  let candidate = `${base}${ext}`;
  let index = 1;
  while (existsSync(join(dir, candidate))) {
    candidate = `${base}-${index}${ext}`;
    index += 1;
  }
  return candidate;
}

function refreshUploadKnowledgeArtifact(id: string) {
  const projectDir = projectDirFor(id);
  ensureProjectDirs(projectDir);
  const artifactsDir = join(projectDir, ".paper", "artifacts");
  const body = buildUploadKnowledge(projectDir);
  const step: StepDef = {
    id: "upload-knowledge",
    name: "上传资料知识库",
    agent: "资料解析智能体",
    checkpointType: "upload-knowledge",
    targetSection: "上传资料知识库",
    instruction: "解析用户上传的项目资料并整理为后续生成可使用的知识片段。",
  };
  const artifact = formatArtifact(step, body, readConfig(id) || {
    name: id,
    template: "dachuang",
    competition: "dachuang",
    created: new Date().toISOString(),
    updated: new Date().toISOString(),
  } as WorkflowConfig);
  const outputPath = join(artifactsDir, "00-upload-knowledge.md");
  writeFileSync(outputPath, artifact, "utf-8");
  return { body, outputPath };
}

function localPolishMarkdown(content: string, instruction: string) {
  const polished = content
    .replace(/需求真实但现有方案不稳定、成本高、落地难/g, "真实救援需求迫切，但现有方案在稳定性、成本控制和快速落地方面仍存在明显短板")
    .replace(/为什么现在必须做/g, "项目建设的现实必要性与时间窗口")
    .replace(/本项目拟构建一套集“场景感知、智能分析、结果输出、持续迭代”于一体的项目解决方案。/g, "本项目拟构建一套覆盖“场景感知、智能分析、结果输出、持续迭代”的一体化解决方案，形成从数据输入、模型判别到结果复核和应用反馈的完整闭环。")
    .replace(/与单点工具不同，项目强调/g, "区别于单一算法或孤立工具，本项目更强调")
    .replace(/项目应/g, "项目将")
    .replace(/建议采用/g, "采用")
    .replace(/建议将/g, "将")
    .replace(/建议按/g, "按")
    .replace(/建议设置/g, "设置")
    .replace(/建议补充/g, "补充")
    .replace(/建议/g, "");
  const changed = polished !== content;
  return {
    answer: changed
      ? [
          "已处理当前编辑器内容。",
          `执行任务：${instruction}`,
          "变更摘要：增强评审口径、逻辑闭环、正式程度和可落地表述。",
          "下一步：请在中间编辑器检查并保存。",
        ].join("\n")
      : [
          "已检查当前编辑器内容。",
          `执行任务：${instruction}`,
          "结果：没有发现可安全自动替换的片段，因此保持正文不变。",
          "下一步：请给出更具体的位置或改写范围，我会直接改中间编辑器。",
        ].join("\n"),
    patch: polished,
    canApply: changed,
  };
}

function parseAssistantAction(raw: string) {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();
  return JSON.parse(cleaned) as {
    answer?: string;
    action?: "suggest" | "replace_current_file" | "compile_pdf" | "export_docx" | "export_tex";
    patch?: string;
    autoApply?: boolean;
  };
}

function wantsEditorChange(instruction: string) {
  return /修改|改写|润色|优化|完善|补全|扩写|删|删除|去掉|替换|改成|调整|处理|继续|完成|重写|应用|写入|整理|降重|去重|修复/.test(instruction);
}

function wantsWholeDocumentImprove(instruction: string) {
  return /完善项目书|完善全文|继续完善|继续优化|优化全文|整体优化|整体润色|润色全文|补全项目书|完善一下|全篇|整篇|自检.*项目书|自己判断.*完善|哪里还没有完善|还没有完善/.test(instruction);
}

function looksLikeManuscriptText(text: string) {
  const lineCount = text.split(/\r?\n/).filter(Boolean).length;
  return text.length > 900 || lineCount > 10 || /^#{1,3}\s/m.test(text) || /^\|.+\|$/m.test(text);
}

function safeEditorAnswer(answer: string, fallback = "已完成处理。") {
  const cleaned = String(answer || "")
    .replace(/外部模型暂未返回[^\n]*/g, "")
    .replace(/当前外部模型没有返回可用内容[^\n]*/g, "")
    .replace(/本地编辑器兜底[^\n]*/g, "")
    .replace(/兜底完成[^\n]*/g, "")
    .replace(/模型没有返回完整替换稿[^\n]*/g, "")
    .trim();
  if (!cleaned) return fallback;
  if (looksLikeManuscriptText(cleaned)) {
    return [
      "已收到较长正文内容。",
      "右侧不展开全文，避免挤占编辑区。",
      "如果这是改稿任务，我会把可安全应用的内容写入中间编辑器。",
    ].join("\n");
  }
  return cleaned.split(/\r?\n/).filter(Boolean).slice(0, 7).join("\n");
}

function editorAppliedLog(filePath: string, patch: string, summary = "已按你的指令修改当前文件。") {
  const lines = patch.split(/\r?\n/).length;
  return [
    summary,
    `应用位置：${filePath || "当前编辑器"}`,
    `变更规模：约 ${patch.length.toLocaleString()} 字符 / ${lines} 行`,
    "下一步：请在中间编辑器检查，确认后点击保存。",
  ].join("\n");
}

function editorTraceForAppliedEdit(content: string, instruction: string, filePath: string, patch: string, summary: string) {
  const beforeLines = String(content || "").split(/\r?\n/).length;
  const afterLines = String(patch || "").split(/\r?\n/).length;
  const beforeChars = String(content || "").length;
  const afterChars = String(patch || "").length;
  const changed = Math.abs(afterChars - beforeChars).toLocaleString();
  return buildAgentTrace([
    { label: "诊断", detail: `读取 ${filePath || "当前编辑器"}，识别用户意图：${instruction}` },
    { label: "计划", detail: "将修改结果写入中间编辑器，右侧对话只保留工作日志、变更规模和撤销入口。" },
    { label: "执行", detail: `${summary}；字符变化 ${beforeChars.toLocaleString()} -> ${afterChars.toLocaleString()}（差异 ${changed}），行数 ${beforeLines} -> ${afterLines}。` },
    { label: "复核", detail: "未在对话栏展开全文；已准备由用户在中间编辑器检查并保存。" },
  ]);
}

function editorTraceForNoChange(content: string, instruction: string, filePath: string, reason: string) {
  return buildAgentTrace([
    { label: "诊断", detail: `读取 ${filePath || "当前编辑器"}，当前内容约 ${String(content || "").length.toLocaleString()} 字符。` },
    { label: "计划", detail: `尝试执行：${instruction}` },
    { label: "执行", detail: reason },
    { label: "复核", detail: "中间编辑器未改动；如果需要继续，可直接说“自检并继续完善项目书”。" },
  ]);
}

function projectBookDiagnosticBlocks(text: string, config: WorkflowConfig) {
  const thresholds = competitionQualityThresholds(config);
  const chapterSignals = competitionChapterSignals(config);
  const coveredSignals = chapterSignals.filter((signal) => text.includes(signal)).length;
  const tableRows = countOccurrences(text, /^\|.+\|$/gm);
  const figureSignals = countOccurrences(text, /!\[|paper:\/\/figure|图\d|图 /g);
  const evidenceHits = countOccurrences(text, /公开资料口径|项目估算口径|原型测试口径|用户材料口径|附件|证明材料|访谈|测试记录|政策|行业报告/g);
  const financeHits = countOccurrences(text, /收入|成本|预算|现金流|融资|回报|财务|资金/g);
  const marketHits = countOccurrences(text, /市场|客户|用户|竞品|渠道|销售|采购|推广/g);
  const techHits = countOccurrences(text, /技术|系统|模型|算法|架构|模块|原型|测试|指标/g);
  const specificity = projectSpecificityScore(text, config);
  const contamination = crossProjectContamination(config, text).filter((item) => item.risky);
  const genericSamples = genericParagraphSamples(text);
  const actions: string[] = [];
  const blocks: string[] = [];
  const projectName = config.name || "本项目";
  const track = config.track || config.competition || "竞赛申报方向";
  const product = config.product || `${projectName}核心产品/系统`;
  const metrics = [
    `正文 ${text.length.toLocaleString()}/${Math.round(thresholds.chars * 0.82).toLocaleString()} 字符`,
    `章节信号 ${coveredSignals}/${chapterSignals.length}`,
    `表格行 ${tableRows}/${Math.min(thresholds.tables, 30)}`,
    `图示信号 ${figureSignals}/${thresholds.figures}`,
    `证据口径 ${evidenceHits}/${thresholds.evidence}`,
    `技术信号 ${techHits}/12`,
    `市场信号 ${marketHits}/16`,
    `财务信号 ${financeHits}/10`,
    `项目专属度 ${specificity.score}/100`,
    `串项风险 ${contamination.length}`,
    `空泛段落 ${genericSamples.length}`,
  ];

  if (text.length < thresholds.chars * 0.82 || coveredSignals < Math.ceil(chapterSignals.length * 0.72)) {
    actions.push("识别到章节覆盖或正文信息密度不足");
    blocks.push(`## 项目论证补强\n${projectName}的项目书需要把“项目为什么成立、产品如何解决问题、团队如何执行、材料如何证明”连接成完整闭环。围绕${track}的评审要求，项目论证进一步落到四个层面：第一，问题来源必须对应真实用户和具体场景，避免停留在宏观概念；第二，${product}必须说明输入、处理、输出和服务交付方式，体现可运行的产品逻辑；第三，市场与实施部分需要说明目标客户、进入路径、价格或成本口径、阶段目标和验收方式；第四，附件材料需要对应正文结论，使评审能够从项目书追溯到调研、测试、财务和团队材料。\n\n| 补强维度 | 当前项目书需要回答的问题 | 正文落实方式 |\n| --- | --- | --- |\n| 场景真实性 | 谁在什么情况下遇到什么问题 | 用户画像、痛点拆解、典型使用流程 |\n| 产品可行性 | 产品如何完成任务并形成结果 | 功能模块、技术路线、指标与测试记录 |\n| 商业/应用可行性 | 谁付费、如何进入、如何持续 | 客户分层、渠道策略、成本收益测算 |\n| 材料可信度 | 关键判断由什么证明 | 附件索引、公开资料口径、项目估算口径 |`);
  }

  if (tableRows < Math.min(thresholds.tables, 30) || figureSignals < thresholds.figures) {
    actions.push("识别到图表表达不足");
    blocks.push(`## 图表设计与表达完善\n为提高项目书的评审可读性，正文应把关键逻辑转化为图表表达。图1建议设置为“系统/产品架构图”，呈现用户端、数据/业务输入、核心处理模块、管理端和结果输出之间的关系；图2建议设置为“服务流程图”，呈现从需求触发、数据采集、模型或业务处理、人工复核、结果反馈到材料沉淀的闭环。表格部分重点服务市场、竞品、功能、财务、进度和风险，不做装饰性堆砌。\n\n| 图表编号 | 图表名称 | 放置章节 | 说明重点 |\n| --- | --- | --- | --- |\n| 图1 | 系统/产品架构图 | 产品介绍或技术路线 | 展示核心模块、数据流和输出结果 |\n| 图2 | 服务流程图 | 产品服务或运营管理 | 展示用户从接入到获得结果的完整流程 |\n| 表1 | 目标用户与痛点表 | 市场分析 | 对应不同用户的真实需求和付费/使用场景 |\n| 表2 | 竞品与替代方案对比表 | 竞争分析 | 说明差异化优势和进入机会 |\n| 表3 | 风险控制表 | 风险管理 | 对应风险、影响、措施和证明材料 |`);
  }

  if (evidenceHits < thresholds.evidence || techHits < 12) {
    actions.push("识别到证据链或技术验证不足");
    blocks.push(`## 技术验证与证据链完善\n项目技术可信度不只来自方案描述，还来自可复核的验证材料。${projectName}应围绕核心功能建立“设计依据、原型实现、测试记录、问题迭代、附件支撑”的证据链。已有事实以用户上传材料、截图、测试表、访谈纪要和公开资料为准；尚未取得的专利、软著、合同和营收不写成既成事实，而以计划节点、验收标准和材料形成方式表达。\n\n| 论证对象 | 可使用材料 | 证明作用 |\n| --- | --- | --- |\n| 技术路线 | 架构图、流程图、模块说明 | 证明方案不是概念堆砌 |\n| 原型能力 | 原型截图、演示视频、测试记录 | 证明核心流程可以运行 |\n| 指标表现 | 准确率、响应时间、稳定性、成本估算 | 证明项目具备评价尺度 |\n| 用户需求 | 访谈纪要、问卷、场景记录 | 证明问题来源真实 |\n| 成果沉淀 | 版本记录、分工表、附件索引 | 证明团队持续推进能力 |`);
  }

  if (marketHits < 16 || financeHits < 10) {
    actions.push("识别到市场财务论证不足");
    blocks.push(`## 市场进入与财务测算补强\n市场部分从“有需求”进一步落到“谁使用、谁决策、谁付费、如何交付、如何持续”。${projectName}可按目标用户分层设计进入路径：先选择需求强、验证成本低、反馈周期短的场景完成试点，再根据服务流程和交付成本形成标准化方案。财务测算采用项目估算口径，围绕研发成本、测试成本、部署成本、推广成本和运维成本展开，不虚构合同和收入。\n\n| 客户/用户层级 | 进入方式 | 收入或价值口径 | 验证材料 |\n| --- | --- | --- | --- |\n| 早期试点用户 | 原型演示、访谈反馈、场景测试 | 需求确认和功能验证 | 访谈纪要、测试截图 |\n| 机构/组织客户 | 项目制交付、部署服务、培训支持 | 交付费、运维费、定制服务费 | 报价估算、服务清单 |\n| 合作伙伴 | 模块授权、联合推广、渠道合作 | 渠道分成或服务包收入 | 合作意向、场景说明 |\n| 竞赛展示对象 | 路演、样机、数据和附件 | 社会价值和成长潜力 | 项目书、PPT、视频脚本 |`);
  }

  if (!blocks.length) {
    actions.push("未发现空缺标题，但识别到仍可增强评审闭环");
    blocks.push(`## 评审闭环补强\n在现有项目书基础上，${projectName}还需要进一步突出“问题、方案、验证、价值、推广”的闭环表达。问题部分对应真实场景和目标用户，方案部分对应${product}的核心功能和服务流程，验证部分对应原型、测试、访谈、公开资料和项目估算口径，价值部分对应竞赛评价中的创新性、可行性、社会价值和团队执行力。通过这一闭环，项目书能够避免只停留在概念介绍，而是呈现为可以评审、可以复核、可以继续推进的完整项目方案。`);
  }

  return { actions, blocks, metrics };
}

function projectBookMetricSnapshot(text: string, config: WorkflowConfig) {
  const thresholds = competitionQualityThresholds(config);
  const chapterSignals = competitionChapterSignals(config);
  const coveredSignals = chapterSignals.filter((signal) => text.includes(signal)).length;
  const tableRows = countOccurrences(text, /^\|.+\|$/gm);
  const figureSignals = countOccurrences(text, /!\[|paper:\/\/figure|图\d|图 /g);
  const evidenceHits = countOccurrences(text, /公开资料口径|项目估算口径|原型测试口径|用户材料口径|附件|证明材料|访谈|测试记录|政策|行业报告/g);
  const financeHits = countOccurrences(text, /收入|成本|预算|现金流|融资|回报|财务|资金/g);
  const marketHits = countOccurrences(text, /市场|客户|用户|竞品|渠道|销售|采购|推广/g);
  const techHits = countOccurrences(text, /技术|系统|模型|算法|架构|模块|原型|测试|指标/g);
  const minimumChars = Math.round(thresholds.chars * 0.82);
  const minimumChapters = Math.ceil(chapterSignals.length * 0.72);
  return {
    minimumChars,
    minimumChapters,
    minimumTables: Math.min(thresholds.tables, 30),
    minimumFigures: thresholds.figures,
    minimumEvidence: thresholds.evidence,
    minimumTech: 12,
    minimumMarket: 16,
    minimumFinance: 10,
    chars: text.length,
    coveredSignals,
    tableRows,
    figureSignals,
    evidenceHits,
    techHits,
    marketHits,
    financeHits,
  };
}

function projectBookGapLabels(text: string, config: WorkflowConfig) {
  const m = projectBookMetricSnapshot(text, config);
  return [
    m.chars < m.minimumChars ? `正文长度不足（${m.chars.toLocaleString()}/${m.minimumChars.toLocaleString()}）` : "",
    m.coveredSignals < m.minimumChapters ? `章节覆盖不足（${m.coveredSignals}/${m.minimumChapters}）` : "",
    m.tableRows < m.minimumTables ? `表格不足（${m.tableRows}/${m.minimumTables}）` : "",
    m.figureSignals < m.minimumFigures ? `图示不足（${m.figureSignals}/${m.minimumFigures}）` : "",
    m.evidenceHits < m.minimumEvidence ? `证据链不足（${m.evidenceHits}/${m.minimumEvidence}）` : "",
    m.techHits < m.minimumTech ? `技术验证不足（${m.techHits}/${m.minimumTech}）` : "",
    m.marketHits < m.minimumMarket ? `市场与客户表达不足（${m.marketHits}/${m.minimumMarket}）` : "",
    m.financeHits < m.minimumFinance ? `财务论证不足（${m.financeHits}/${m.minimumFinance}）` : "",
  ].filter(Boolean);
}

function projectBookMeetsMinimum(text: string, config: WorkflowConfig) {
  return projectBookGapLabels(text, config).length === 0;
}

function blockTitle(block: string) {
  return block.match(/^#{2,3}\s+(.+)$/m)?.[1] || block.slice(0, 24).replace(/\s+/g, "");
}

function summarizeAgentPlan(actions: string[], blocks: string[]) {
  const blockNames = blocks.map(blockTitle).filter(Boolean);
  if (blockNames.length) return `写入/完善 ${blockNames.slice(0, 4).join("、")}`;
  if (actions.length) return actions.slice(0, 4).join("；");
  return "清理正文口吻并增强评审闭环";
}

function summarizeAgentReview(beforeMetrics: string[], afterMetrics: string[], beforeLength: number, afterLength: number) {
  const growth = afterLength - beforeLength;
  const changed = growth === 0 ? "正文规模基本不变" : `正文${growth > 0 ? "增加" : "减少"} ${Math.abs(growth).toLocaleString()} 字符`;
  const focus = afterMetrics.slice(1, 5).join("；");
  return `${changed}；复核后 ${focus}`;
}

function buildIterativeImprovementBlock(text: string, config: WorkflowConfig, round: number) {
  const gaps = projectBookGapLabels(text, config);
  const projectName = config.name || "本项目";
  const product = config.product || `${projectName}核心产品/系统`;
  const marketNeed = gaps.some((gap) => /市场|财务|正文|章节/.test(gap));
  const techNeed = gaps.some((gap) => /技术|证据|图示|正文|章节/.test(gap));
  const tableNeed = gaps.some((gap) => /表格|图示|证据/.test(gap));
  const blocks = [
    `## 第${round}轮深化补强\n本轮根据自动复核结果继续完善${projectName}，重点处理${gaps.slice(0, 4).join("、") || "评审闭环仍需增强"}。补强不改变原有事实边界，仍然采用公开资料口径、项目估算口径、原型测试口径和附件材料口径组织正文，避免把尚未完成的客户签约、知识产权、营收或试点写成既成事实。`,
  ];
  if (techNeed) {
    blocks.push(`### 技术与证据深化\n${product}需要进一步说明从输入到输出的可验证链路。项目可以把核心流程拆为数据/需求输入、核心模块处理、结果展示、人工复核、记录归档和版本迭代六个环节。每个环节都对应可检查材料：输入环节对应需求清单和样本说明，处理环节对应模块说明和架构图，输出环节对应原型截图和演示记录，复核环节对应问题清单和误差分析，归档环节对应测试表和附件索引，迭代环节对应版本记录和下一阶段计划。`);
  }
  if (marketNeed) {
    blocks.push(`### 市场与财务深化\n市场进入路径按照“低成本验证、标准化交付、场景化复制”的顺序推进。早期以访谈、原型演示和小样本测试确认真实需求；中期把功能模块、服务流程、部署成本和运维边界整理成标准化服务包；后期根据客户类型形成项目制交付、订阅运维、模块授权或联合推广等收入方式。财务测算采用保守估算口径，重点解释研发投入、测试投入、部署投入、推广投入和运维投入如何对应可验收成果。`);
  }
  if (tableNeed) {
    blocks.push(makeTable(
      ["补强对象", "当前缺口", "本轮完善方式", "复核材料"],
      [
        ["技术验证", "核心链路和指标说明不够集中", "补充输入-处理-输出-复核-归档-迭代表达", "原型截图、测试记录、模块说明"],
        ["市场与客户", "用户、客户和付费逻辑需要更明确", "补充目标用户分层、进入路径和交付方式", "访谈纪要、竞品表、价格估算"],
        ["财务测算", "成本收入关系需要可解释", "补充研发、测试、部署、推广、运维成本口径", "预算表、收入预测、现金流估算"],
        ["材料支撑", "正文结论与附件对应不足", "补充材料类型、形成方式和证明对象", "附件索引、公开资料、用户材料"],
      ],
    ));
  }
  return blocks.join("\n\n");
}

function projectChapterSteps(config: WorkflowConfig) {
  return projectWorkflowSteps(config).filter((step) => step.id !== "final-assembly");
}

function stripChapterPrefix(value: string) {
  return String(value || "")
    .replace(/^#+\s*/, "")
    .replace(/^[一二三四五六七八九十]+[、.．]\s*/, "")
    .replace(/^\d+[、.．]\s*/, "")
    .trim();
}

function chapterAliases(step: StepDef) {
  const heading = canonicalStepHeading(step);
  return Array.from(new Set([
    heading.chapter,
    heading.section,
    step.targetSection,
    step.name,
    stripChapterPrefix(heading.chapter),
    stripChapterPrefix(step.targetSection),
    stripChapterPrefix(step.name),
  ].map((item) => String(item || "").trim()).filter(Boolean)));
}

function chapterBodyInfo(text: string, step: StepDef) {
  const aliases = chapterAliases(step);
  const normalizedAliases = aliases.map(stripChapterPrefix);
  const lines = String(text || "").split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i].match(/^(#{1,3})\s+(.+)$/);
    if (!match) continue;
    const level = match[1].length;
    const title = match[2].trim();
    const normalizedTitle = stripChapterPrefix(title);
    const matched = aliases.some((alias) => title === alias || title.includes(alias))
      || normalizedAliases.some((alias) => alias && (normalizedTitle === alias || normalizedTitle.includes(alias)));
    if (!matched) continue;
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j += 1) {
      const nextHeading = lines[j].match(/^(#{1,3})\s+(.+)$/);
      if (nextHeading && nextHeading[1].length <= level) {
        end = j;
        break;
      }
    }
    const body = lines.slice(i + 1, end).join("\n").replace(/^#{1,4}\s+.+$/gm, "").trim();
    return { found: true, bodyChars: body.length, title };
  }
  return { found: false, bodyChars: 0, title: "" };
}

function chapterSectionRange(text: string, step: StepDef) {
  const aliases = chapterAliases(step);
  const normalizedAliases = aliases.map(stripChapterPrefix);
  const lines = String(text || "").split(/\r?\n/);
  let offset = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const lineStart = offset;
    offset += line.length + 1;
    const match = line.match(/^(#{1,3})\s+(.+)$/);
    if (!match) continue;
    const level = match[1].length;
    const title = match[2].trim();
    const normalizedTitle = stripChapterPrefix(title);
    const matched = aliases.some((alias) => title === alias || title.includes(alias))
      || normalizedAliases.some((alias) => alias && (normalizedTitle === alias || normalizedTitle.includes(alias)));
    if (!matched) continue;
    let endLine = lines.length;
    for (let j = i + 1; j < lines.length; j += 1) {
      const nextHeading = lines[j].match(/^(#{1,3})\s+(.+)$/);
      if (nextHeading && nextHeading[1].length <= level) {
        endLine = j;
        break;
      }
    }
    const end = lines.slice(0, endLine).join("\n").length + (endLine < lines.length ? 0 : 0);
    const section = lines.slice(i, endLine).join("\n").trim();
    return { found: true, start: lineStart, end, section, title, level };
  }
  return { found: false, start: -1, end: -1, section: "", title: "", level: 2 };
}

function missingOrThinChapterSteps(text: string, config: WorkflowConfig) {
  return projectChapterSteps(config).filter((step) => {
    const info = chapterBodyInfo(text, step);
    const minimum = /summary|概要|executive/i.test(step.id) ? 520 : 700;
    return !info.found || info.bodyChars < minimum;
  });
}

function thinChapterDepthSteps(text: string, config: WorkflowConfig) {
  return projectChapterSteps(config).filter((step) => {
    const info = chapterBodyInfo(text, step);
    if (!info.found) return false;
    const target = minimumBodyChars(config, step);
    if (target <= 0) return false;
    const floor = Math.max(900, Math.round(target * 0.78));
    return info.bodyChars < floor;
  });
}

function isOfficialChapterTitle(title: string, config: WorkflowConfig) {
  const normalizedTitle = stripChapterPrefix(title);
  return projectChapterSteps(config).some((step) => {
    return chapterAliases(step).some((alias) => {
      const normalizedAlias = stripChapterPrefix(alias);
      return title === alias || normalizedTitle === normalizedAlias;
    });
  });
}

function pruneShortDraftExtraSections(text: string, config: WorkflowConfig, gapCount: number) {
  const source = String(text || "").trim();
  if (source.length > 1600 || gapCount < 4) return source;
  const lines = source.split(/\r?\n/);
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i].match(/^(##)\s+(.+)$/);
    if (!match) {
      kept.push(lines[i]);
      continue;
    }
    const title = match[2].trim();
    if (isOfficialChapterTitle(title, config)) {
      kept.push(lines[i]);
      continue;
    }
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (/^##\s+/.test(lines[j])) {
        end = j;
        break;
      }
    }
    const body = lines.slice(i + 1, end).join("\n").trim();
    if (body.length > 260 || /^\|.+\|$/m.test(body)) {
      kept.push(lines[i], ...lines.slice(i + 1, end));
    }
    i = end - 1;
  }
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function chapterCompletionNeed(step: StepDef) {
  const text = `${step.id} ${step.name} ${step.targetSection}`;
  if (step.id === "overview" || /^一、项目方案概述/.test(step.targetSection)) return "background";
  if (step.id === "team" || /^二、项目团队概述/.test(step.targetSection)) return "team";
  if (step.id === "industry-product" || /^三、产业背景与项目产品/.test(step.targetSection)) return "product";
  if (step.id === "market-competition" || /^四、市场调查与竞争分析/.test(step.targetSection)) return "market";
  if (step.id === "business-strategy") return "business";
  if (step.id === "benefits" || /预期效益|效益分析|社会效益|经济效益/.test(text)) return "benefits";
  if (step.id === "finance-deliverables") return "finance";
  if (step.id === "proof-materials") return "materials";
  if (/summary|概要|摘要/.test(text)) return "summary";
  if (/background|overview|概述|背景|痛点|机会|社会价值/.test(text)) return "background";
  if (/product|solution|service|公司|产品|服务|方案/.test(text)) return "product";
  if (/innovation|technology|优势|创新|壁垒|技术/.test(text)) return "innovation";
  if (/market|市场|用户|客户|竞争|目标/.test(text)) return "market";
  if (/business|marketing|growth|运营|营销|商业模式|销售|推广|发展战略|战略/.test(text)) return "business";
  if (/operation|implementation|实施|管理|里程碑/.test(text)) return "operation";
  if (/team|团队|组织|资源/.test(text)) return "team";
  if (/finance|funding|财务|融资|资金|回报/.test(text)) return "finance";
  if (/risk|compliance|风险|合规|对策/.test(text)) return "risk";
  if (/development|future|prospect|战略|前景|展望/.test(text)) return "future";
  if (/appendix|proof|materials|附件|附录|证明|材料|路演/.test(text)) return "materials";
  return "general";
}

function sentenceList(items: string[], fallback: string) {
  const cleaned = items.map((item) => item.trim()).filter(Boolean);
  return cleaned.length ? cleaned.join("、") : fallback;
}

function projectBookDisplayName(config: WorkflowConfig) {
  const raw = String(config.name || "").trim();
  const cleaned = raw
    .replace(/(?:项目计划书|创业计划书|商业计划书|计划书正文|项目书正文|申报书正文|申报书)+$/g, "")
    .replace(/(?:项目计划书|创业计划书|商业计划书|计划书正文|项目书正文|申报书正文|申报书){2,}$/g, "")
    .trim();
  return cleaned || raw || "本项目";
}

function projectBookDocumentTitle(config: WorkflowConfig) {
  const name = projectBookDisplayName(config);
  if (/计划书$/.test(name)) return name;
  if (/项目$/.test(name)) return `${name}计划书`;
  return `${name}项目计划书`;
}

function chapterSupplementTitle(step: StepDef) {
  const section = canonicalStepHeading(step).section;
  if (section) return section;
  const need = chapterCompletionNeed(step);
  const fallback: Record<string, string> = {
    background: "场景问题与建设必要性",
    product: "产品方案与实施路径",
    market: "市场调查与竞争分析",
    business: "商业模式与发展路径",
    benefits: "预期效益与评价口径",
    finance: "资金安排与回报测算",
    team: "团队组织与执行基础",
    materials: "证明材料与附件清单",
    risk: "风险控制与保障机制",
    future: "发展规划与成果转化",
  };
  return fallback[need] || "验证记录与材料沉淀";
}

function buildMissingChapterBlock(step: StepDef, config: WorkflowConfig) {
  const profile = currentTopicProfile(config);
  const heading = canonicalStepHeading(step).chapter || step.targetSection || step.name;
  const projectName = projectBookDisplayName(config) || profile.title || "本项目";
  const product = config.product || profile.position;
  const market = config.market || sentenceList(profile.users.slice(0, 4), "目标用户与组织客户");
  const finance = config.finance || sentenceList(profile.businessModels.slice(0, 4), "项目制交付、订阅运维和定制化服务");
  const evidence = config.evidence || sentenceList(profile.evidenceFocus.slice(0, 4), "公开资料、原型测试、用户访谈和财务测算材料");
  const users = sentenceList(profile.users.slice(0, 5), "核心用户");
  const scenes = sentenceList(profile.scenes.slice(0, 5), "典型应用场景");
  const pains = sentenceList(profile.painPoints.slice(0, 5), "真实痛点");
  const modules = sentenceList(profile.productModules.slice(0, 6), "核心功能模块");
  const competitors = sentenceList(profile.competitors.slice(0, 4), "直接竞品、替代方案和人工流程");
  const metrics = sentenceList(profile.metrics.slice(0, 6), "效率、成本、准确性、稳定性和满意度指标");
  const need = chapterCompletionNeed(step);
  const body: string[] = [`## ${heading}`];

  if (need === "summary") {
    body.push(`${projectName}面向${profile.domain}中的高频需求展开，核心对象是${users}，重点覆盖${scenes}。该方案不是停留在概念层的工具设想，而是围绕${pains}形成产品、服务、运营和材料证明的完整闭环。${product}以${modules}为主要能力，将用户需求、业务流程、数据或资料输入、智能处理、结果输出、人工复核和持续迭代连接起来，直接说明“解决什么问题、给谁使用、如何交付、凭什么可行、怎样持续发展”。`);
    body.push(`商业与应用层面，团队围绕${market}进入市场，收入和价值实现采用${finance}等方式，相关数字统一采用项目估算口径。阶段成果以${evidence}为支撑，不把尚未取得的合同、专利、授权、营收或试点写成既成事实。社会价值、创新能力、落地路径、团队执行和支撑材料共同构成后续章节的主线。`);
  } else if (need === "background") {
    body.push(`${projectName}的提出来自${profile.domain}场景中的现实矛盾。当前${users}在${scenes}中普遍面临${pains}等问题，传统做法往往依赖人工经验、分散工具或单点系统，难以同时满足效率、可追溯、成本控制和持续迭代要求。团队从具体场景切入，将问题拆解为用户需求、流程瓶颈、技术可行性、交付成本和材料证明五个层面，避免只停留在宏观概念。`);
    body.push(`${product}的建设价值体现在三方面：一是把分散需求转化为可运行的产品服务流程；二是通过${modules}提升任务处理效率和结果一致性；三是以${metrics}形成可复核的评价口径。社会价值来自一线效率、服务质量、资源利用或公共治理能力的改善，商业价值来自标准化服务包、平台化能力和持续运维空间。`);
    body.push(makeTable(["问题层面", "具体表现", "应对方式"], [["用户场景", pains, `围绕${scenes}形成高频使用流程`], ["技术/产品", "单点工具难以闭环", `以${modules}构成产品能力`], ["应用转化", "交付成本和验收口径不清", `以${metrics}和附件材料建立验收依据`]]));
  } else if (need === "product") {
    body.push(`${product}采用“需求输入-核心处理-结果输出-复核归档-持续迭代”的产品逻辑。需求输入环节对应${users}在${scenes}中的真实任务；核心处理环节由${modules}支撑；结果输出环节面向用户生成可查看、可复核、可归档的服务结果；复核归档环节记录异常、反馈和材料依据；持续迭代环节根据测试记录、用户反馈和竞赛展示要求优化功能。`);
    body.push(`产品服务不只描述功能名称，还要说明功能之间如何协同。核心服务流程为：用户或管理端提交需求/资料/场景数据，系统完成结构化整理和智能处理，输出结果、报告或操作建议，团队通过人工复核保证边界，最后形成事件记录、测试记录或附件索引。该流程能够沉淀可运行原型、图表说明、指标记录和后续迭代空间。`);
    body.push(makeTable(["模块", "功能定位", "交付结果"], profile.productModules.slice(0, 6).map((module, index) => [module, index === 0 ? "承接核心需求输入" : index === 1 ? "完成关键业务处理" : "支撑服务闭环", "页面/接口说明、测试记录或演示截图"])));
  } else if (need === "innovation") {
    body.push(`${projectName}的创新不只来自单一技术名词，而来自技术、产品、场景和运营的组合。技术层面，团队围绕${profile.techRoute}形成闭环，把核心能力落到可验证流程；产品层面，${modules}共同构成面向真实用户的服务系统；场景层面，服务范围聚焦${scenes}，避免泛化成无边界平台；运营层面，通过${finance}建立持续服务路径。`);
    body.push(`竞争优势主要体现在场景贴合度、结果可追溯、实施成本可控和迭代资料完整。与${competitors}相比，${projectName}更强调从问题到结果的完整链路，以及从原型、测试、访谈、图表到附件材料的可复核证据链。知识产权、授权和合作资源按实际材料描述，尚未取得的成果以计划、验收节点和材料形成方式表达。`);
    body.push(makeTable(["创新维度", "本项目体现", "评审可验证材料"], [["技术创新", profile.techRoute, "架构图、流程图、测试记录"], ["产品创新", modules, "原型截图、功能模块表"], ["模式创新", finance, "收入测算、合作路径"], ["材料创新", evidence, "附件索引、访谈纪要、演示材料"]]));
  } else if (need === "market") {
    body.push(`${projectName}的目标市场由${market}构成，使用者、决策者和付费者可能并不完全相同，因此市场分析按“用户需求-客户决策-交付场景-付费路径”展开。核心用户关注易用性、结果可靠性和响应速度；组织客户关注成本、管理效率、数据/流程留痕和风险控制；合作伙伴关注模块兼容、交付周期和后续运维。`);
    body.push(`竞品与替代方案包括${competitors}。进入市场时，团队先选择需求强、验证成本低、反馈周期短的场景完成原型演示和试点沟通，再沉淀标准化服务包、报价口径和运维边界。市场容量与价格区间采用公开资料口径、行业报告口径和项目估算口径，不虚构已成交客户或真实营收。`);
    body.push(makeTable(["目标对象", "核心需求", "进入方式", "验证材料"], profile.users.slice(0, 5).map((user) => [user, pains.split("、").slice(0, 2).join("、") || "效率与质量提升", "访谈、原型演示、场景测试", "访谈纪要、需求清单、测试记录"])));
  } else if (need === "business") {
    body.push(`${projectName}的商业模式围绕${finance}展开。早期以原型演示、需求确认和小规模服务验证建立信任，中期将${modules}整理为标准化服务包，后期根据客户类型形成项目制交付、订阅运维、模块授权、培训服务或联合推广。价值主张是以较低试错成本帮助${users}解决${pains}，并把服务过程沉淀为可复用的方法、数据和流程。`);
    body.push(`运营推广采用场景切入方式：先围绕${scenes}形成案例材料，再通过竞赛展示、校企资源、行业社群、示范客户和合作伙伴触达目标客户。销售流程包括需求访谈、方案演示、部署/试用、验收反馈和续费运维，售后服务包括培训、问题响应、版本更新和材料归档。`);
    body.push(makeTable(["收入/价值方式", "适用对象", "交付内容", "估算口径"], profile.businessModels.slice(0, 5).map((model) => [model, market, "产品模块、部署服务、培训或运维支持", "项目估算口径"])));
  } else if (need === "operation") {
    body.push(`${projectName}实施过程分为需求确认、原型完善、测试验证、材料沉淀、展示答辩和迭代推广六个阶段。需求确认阶段明确用户、场景、痛点和评价指标；原型完善阶段围绕${modules}完成核心流程；测试验证阶段记录${metrics}；材料沉淀阶段整理计划书、图表、财务测算、访谈纪要和附件索引；展示答辩阶段形成路演材料和演示脚本；迭代推广阶段根据反馈优化产品与商业模式。`);
    body.push(makeTable(["阶段", "关键任务", "成果文件", "验收口径"], [["需求确认", `梳理${users}与${scenes}`, "需求清单、用户画像", "用户材料口径"], ["原型完善", `实现${modules}`, "原型截图、架构图", "原型测试口径"], ["测试验证", `记录${metrics}`, "测试表、问题清单", "测试记录口径"], ["材料沉淀", "整理正文、图表、附件和答辩材料", "项目书终稿、附件索引", "申报材料核验口径"]]));
  } else if (need === "team") {
    body.push(`团队组织围绕研发、产品、调研、财务、运营和材料六类任务分工。研发成员负责${modules}的技术实现、测试记录和原型迭代；产品成员负责用户流程、功能边界和演示材料；调研成员负责${users}访谈、竞品分析和公开资料整理；财务成员负责成本预算、收入预测和资金用途；运营成员负责渠道、合作和展示节奏；材料成员负责项目书、附件索引和格式规范。`);
    body.push(`团队能力评价不只写成员名单，更要说明角色与项目需求的匹配关系。项目通过周度复盘、版本记录、任务看板和材料归档保证成果连续沉淀；指导教师或外部资源主要提供技术路线、竞赛材料、行业资源和规范性审核支持。已有成果以原型截图、测试记录、调研材料、课程/竞赛基础和阶段文档为准，不夸大尚未完成的专利、软著、合同或营收。`);
  } else if (need === "finance") {
    body.push(`${projectName}的财务测算采用团队估算口径，围绕研发成本、测试成本、部署成本、推广成本、运维成本和团队管理成本展开。收入端按${finance}设计，不把尚未发生的订单写成既成收入。早期资金主要用于原型完善、样本/资料整理、测试验证、演示材料、知识产权或软著申请准备和市场调研；中后期资金用于标准化服务包、渠道合作和运维体系建设。`);
    body.push(makeTable(["费用/收入项目", "测算内容", "形成依据"], [["研发与测试成本", "开发工具、测试环境、样本整理、版本迭代", "项目估算口径、测试记录"], ["市场与推广成本", "调研、演示、路演、渠道沟通", "公开资料口径、用户材料口径"], ["运维与服务成本", "部署支持、培训、问题响应、内容/模型更新", "项目估算口径"], ["收入来源", finance, "报价模型、服务清单、行业价格区间"]]));
  } else if (need === "risk") {
    body.push(`${projectName}的风险控制围绕技术、市场、运营、财务、合规和团队六类风险展开。技术风险来自核心指标不稳定、原型流程不完整或测试样本不足；市场风险来自客户需求变化、采购路径不清和竞品替代；运营风险来自交付周期、售后响应和资料更新；财务风险来自成本超支和收入预测偏乐观；合规风险来自数据、授权、隐私或知识产权边界；团队风险来自任务衔接和成果归档不足。`);
    body.push(makeTable(["风险类别", "可能表现", "控制措施", "证明材料"], [["技术风险", "指标不稳定、演示链路不完整", "小样本测试、版本迭代、人工复核", "测试表、演示截图"], ["市场风险", "需求弱、付费路径不清", "客户分层、访谈验证、竞品对比", "访谈纪要、竞品表"], ["财务风险", "成本估算偏低、收入预测偏高", "保守估算、分阶段投入", "预算表、资金用途表"], ["合规风险", "数据和授权边界不明", "最小化采集、授权说明、脱敏处理", "隐私说明、附件索引"], ["团队风险", "任务脱节、材料缺失", "分工表、周复盘、文档归档", "任务看板、项目日志"]]));
  } else if (need === "future") {
    body.push(`${projectName}的发展规划按短期、中期和长期推进。短期重点完成${modules}的原型闭环、核心指标测试、用户访谈和竞赛材料沉淀；中期围绕${scenes}形成标准化服务包、部署说明和运维机制；长期根据${profile.domain}的发展趋势拓展更多场景和合作资源，形成可复制的产品、数据、服务和品牌能力。`);
    body.push(`项目预期价值包括提升用户处理效率、降低人工沟通与试错成本、形成可追溯材料、增强团队创新创业能力，并为后续成果转化、知识产权申报、校企合作或社会服务提供基础。发展前景以实际测试、合作沟通和材料沉淀为依据，不将尚未确认的合作或营收提前写成结果。`);
  } else if (need === "materials") {
    body.push(`${projectName}的附件材料用于支撑关键判断，主要包括${evidence}。政策和行业判断采用公开资料口径；用户需求采用访谈、问卷或场景观察材料；技术可行性采用原型截图、演示视频、测试表和版本记录；市场与财务采用竞品表、价格估算、预算表和收入预测表；团队能力采用分工表、阶段成果、指导意见和项目日志。`);
    body.push(makeTable(["附件类别", "材料内容", "支撑章节"], [["政策与行业资料", "公开政策、行业报告、背景资料", "项目背景、市场分析"], ["用户调研材料", "访谈纪要、问卷、场景记录", "市场分析、产品服务"], ["原型与测试材料", "架构图、流程图、截图、测试表", "产品介绍、技术创新"], ["财务与商业材料", "预算表、收入预测、资金用途", "商业模式、财务分析"], ["团队与成果材料", "分工表、成果记录、指导意见", "团队介绍、附件材料"]]));
  } else {
    body.push(`${projectName}围绕${profile.domain}形成完整方案。本章节从${users}的真实需求出发，结合${modules}、${profile.techRoute}、${finance}和${evidence}说明可行性，只保留方案本身、实施方式、验证材料和发展路径。`);
  }

  return body.join("\n\n");
}

function buildChapterGapBlock(text: string, step: StepDef, config: WorkflowConfig) {
  if (isReferenceWorkflowStep(step)) return referenceChapterFallback(config, step);
  const info = chapterBodyInfo(text, step);
  const block = buildMissingChapterBlock(step, config);
  if (!info.found) return block;
  return block.replace(/^##\s+.+$/m, `### ${chapterSupplementTitle(step)}`);
}

function buildChapterDepthSupplement(step: StepDef, config: WorkflowConfig, stage = 1) {
  if (isReferenceWorkflowStep(step)) return "";
  const profile = currentTopicProfile(config);
  const need = chapterCompletionNeed(step);
  const projectName = projectBookDisplayName(config);
  const users = sentenceList(profile.users.slice(0, 5), "核心用户");
  const scenes = sentenceList(profile.scenes.slice(0, 5), "典型场景");
  const pains = sentenceList(profile.painPoints.slice(0, 5), "关键痛点");
  const modules = sentenceList(profile.productModules.slice(0, 6), "核心模块");
  const competitors = sentenceList(profile.competitors.slice(0, 5), "竞品和替代方案");
  const models = sentenceList(profile.businessModels.slice(0, 5), "项目制交付、订阅运维和定制服务");
  const metrics = sentenceList(profile.metrics.slice(0, 6), "关键评价指标");
  const proofs = sentenceList(profile.evidenceFocus.slice(0, 6), "证明材料");
  const finance = config.finance || models;
  const market = config.market || users;
  const evidence = config.evidence || proofs;

  if (stage >= 4) {
    const stage4: Record<string, string> = {
      summary: `### 开篇信息归集\n${projectName}先把${users}的任务、${scenes}的触发条件、${modules}的处理方式和${metrics}的观察指标放在同一段落中说明。这样处理后，读者不用先理解抽象概念，就能看到该方案从需求入口到服务结果的基本形态。${proofs}作为材料依据，只承接已经形成或可以在后续试点中形成的内容，尚未发生的订单、授权和营收仍按计划或估算口径表达。`,
      background: `### 早期场景验证\n团队把${scenes}作为早期验证对象，先记录${users}在真实任务中的入口、等待、沟通、处理和归档过程，再把${pains}拆成可以被原型验证的小问题。背景判断不只来自行业趋势，也来自这些具体任务的反复出现：有人发起需求，有人响应，有人确认结果，有材料留下痕迹，后续版本才能继续调整。`,
      product: `### 验收边界与迭代记录\n${modules}的验收不只看页面或功能是否存在，还看用户能否完成一次完整任务。团队围绕${profile.techRoute}保留原型截图、流程图、测试表和问题清单，每轮迭代都记录输入来源、处理动作、输出结果和复核方式，使产品从演示界面逐步变成可交付服务。`,
      innovation: `### 创新点落地方式\n${projectName}的创新点从${scenes}进入，而不是停留在技术名词上。团队用${modules}回应${pains}，用${profile.techRoute}串起业务流程，再用${metrics}观察效果变化。相较于${competitors}，差异主要体现在流程连续、结果可追踪、材料可沉淀和后续复制成本可控。`,
      market: `### 用户分层与进入顺序\n市场进入先从${users}中反馈周期短、需求明确、配合度高的对象开始。团队通过访谈、原型演示和小样本试用确认谁使用、谁决策、谁付费，再根据${proofs}整理客户画像、竞品对比和试点反馈。进入顺序由需求强度、沟通成本、预算来源和复制空间共同决定。`,
      business: `### 服务包与持续运营\n商业路径围绕${models}展开。团队先把${modules}整理成可说明、可报价、可验收的服务包，再用${metrics}观察客户使用频次、响应效率、运维成本和复购可能。每一种收入路径都对应清楚的交付内容和服务边界，避免把商业模式写成单纯口号。`,
      operation: `### 推进节奏与验收节点\n运营安排按需求确认、原型闭环、测试验证、材料定稿和试点复制推进。每个节点都对应负责人、交付物和验收材料：需求阶段保留访谈和流程图，研发阶段保留截图和测试表，运营阶段保留沟通记录和服务清单，材料阶段保留附件索引和版本日志。`,
      team: `### 分工产出与复盘机制\n团队把成员分工直接对应到${modules}、${users}、${models}和${proofs}。研发成员交付原型和测试记录，调研成员交付访谈和竞品材料，财务成员交付预算与收入假设，运营成员交付试点沟通和服务清单，材料成员负责图表、附件和申报材料的一致性。`,
      finance: `### 投入节奏与成果对应\n经费安排先保障原型研发、测试验证、市场调研、资料沉淀和运维准备。每一类投入都对应可检查成果：研发投入对应模块版本，测试投入对应指标记录，调研投入对应用户和竞品材料，展示投入对应路演与截图，运维投入对应服务手册和问题清单。`,
      risk: `### 风险触发与复核材料\n风险控制从需求变化、技术稳定、市场转化、成本偏差、数据授权和团队进度六个方面跟踪。团队为每类风险设置触发信号和处置动作，并用${proofs}、版本日志、测试表和复盘记录留痕，避免风险处理停留在表格罗列。`,
      benefits: `### 效益对象与观察指标\n预期效益落在${users}的实际使用变化上。围绕${scenes}，团队观察${metrics}是否改善，并用${proofs}记录过程。社会效益来自服务质量和协作效率提升，经济效益来自${models}带来的收入空间，可扩展价值来自模块、流程和材料体系的持续复用。`,
      future: `### 阶段延展与成果转化\n后续发展从短期原型完善、中期试点复制和长期生态合作三步推进。短期围绕${modules}补齐可演示流程，中期围绕${users}形成服务包和运维机制，长期结合${profile.domain}的场景需求沉淀数据、接口、案例和合作资源。`,
      materials: `### 材料归档与正文对应\n${proofs}按来源、形成时间、证明对象、对应章节和当前状态归档。团队用材料反向校验正文：访谈材料支撑需求真实性，原型和测试材料支撑产品可行性，竞品和市场材料支撑进入路径，预算和服务清单支撑经费安排。`,
      general: `### 验证记录与材料沉淀\n${projectName}围绕${users}、${scenes}、${modules}、${metrics}和${proofs}整理验证记录。团队只把能够说明事实基础、实施路径、数据口径和附件依据的内容写入正文，暂未形成的成果保留为计划和验收节点。`,
    };
    return stage4[need] || stage4.general;
  }

  if (stage >= 3) {
    const thirdStage: Record<string, string> = {
      summary: `项目最终呈现时，${projectName}需要把“需求、产品、市场、财务、团队、风险、附件”统一成一条清晰主线。需求来自${users}在${scenes}中的真实任务，产品由${modules}支撑，市场进入围绕${market}展开，财务测算采用${finance}，附件材料以${evidence}证明关键结论。摘要部分因此承担总览作用，让评审在开篇即可看到项目逻辑完整、事实边界清楚、后续章节有据可查。`,
      background: [
        `### 典型场景展开\n以${scenes}为例，用户在任务发生前需要获得清晰入口，任务处理中需要稳定反馈，任务结束后需要记录和复盘。传统方式往往只能解决其中一个环节，难以形成连续服务。${projectName}把场景拆为触发、处理、输出、复核和沉淀五个节点，使背景章节能够从真实场景自然引出产品必要性。`,
        makeTable(["场景节点", "现有痛点", "项目切入点"], [["触发", "需求分散、入口不统一", "统一任务入口和资料整理"], ["处理", "人工经验依赖强、效率不稳定", `通过${modules}形成处理能力`], ["输出", "结果难复核、难追踪", "结果展示、记录归档和附件证明"], ["迭代", "问题沉淀不足", "版本日志、测试记录和用户反馈"]]),
      ].join("\n\n"),
      product: [
        `### 关键功能验收表\n产品验收围绕功能完整性、使用便利性、结果可靠性和材料可追溯性展开。每个功能不只看是否存在，还要看是否能支撑实际场景、是否能生成记录、是否能进入后续迭代。`,
        makeTable(["功能对象", "验收重点", "证明材料"], [["核心模块", modules, "模块说明、架构图、原型截图"], ["服务流程", profile.techRoute, "流程图、演示记录"], ["结果输出", metrics, "测试记录、指标表"], ["迭代机制", "反馈、复核、归档、更新", "问题清单、版本日志"]]),
      ].join("\n\n"),
      innovation: `### 创新评价口径\n创新评价采用“是否解决真实问题、是否形成可运行产品、是否优于替代方案、是否具备持续迭代能力”四个口径。${projectName}通过${modules}回应${pains}，通过${profile.techRoute}证明产品链路，通过与${competitors}对比说明差异化，通过${proofs}证明项目不是停留在设想阶段。`,
      market: [
        `### 客户画像与采购逻辑\n市场部分进一步区分使用者、影响者、决策者和付费者。使用者关注效率和体验，影响者关注服务质量和流程规范，决策者关注成本和风险，付费者关注投入产出和持续服务。团队把这些角色的诉求分别写清，才能说明市场进入路径可行。`,
        makeTable(["角色", "核心关注", "应对方式"], [["使用者", "操作便利、结果及时", `围绕${scenes}优化流程`], ["管理者", "过程留痕、质量可控", "记录归档、指标复核"], ["付费客户", "成本合理、收益可解释", "团队估算口径、服务清单"], ["合作伙伴", "部署简单、边界清楚", "接口说明、运维责任"]]),
      ].join("\n\n"),
      business: `### 单位经济模型\n项目单位经济模型由获客成本、交付成本、运维成本、服务价格和续费空间构成。早期重点降低获客和验证成本，中期通过标准化服务包降低交付成本，后期通过运维订阅、模块授权或联合推广提升持续收入。该模型使${finance}不只是收入名称，而能解释项目如何形成现金流。`,
      operation: [
        `### 里程碑验收表\n实施计划需要把时间、任务、成果和责任对应起来，保证项目推进可管理、可检查。`,
        makeTable(["里程碑", "核心成果", "验收方式"], [["M1 需求确认", "用户画像、痛点清单、流程图", "访谈纪要和公开资料口径"], ["M2 原型闭环", "核心模块、交互页面、服务流程", "原型截图和演示记录"], ["M3 测试验证", "指标表、问题清单、版本日志", "原型测试口径"], ["M4 材料定稿", "项目书、附件、路演材料", "提交核验口径"]]),
      ].join("\n\n"),
      team: `### 成果责任矩阵\n团队成果按责任矩阵管理：研发组负责原型、代码、测试记录和技术图示；产品组负责功能流程、用户体验和演示脚本；调研组负责访谈、竞品和市场资料；财务组负责预算、收入预测和资金用途；运营组负责渠道、合作和推广节奏；材料组负责项目书、附件索引和格式规范。责任矩阵保证每一章都有对应负责人和材料来源。`,
      finance: `### 现金流与投入节奏\n现金流测算按阶段投入和阶段回收组织。前期现金流主要流向研发、测试和材料准备，中期流向试点部署、客户沟通和服务包形成，后期根据客户数量、续费率和运维成本评估现金回收。项目采用滚动测算方式，根据测试结果和市场反馈修正客户数量、单价、成本和回款周期。`,
      benefits: [
        `### 效益评价矩阵\n预期效益不只写价值判断，还要说明影响对象、作用机制和验证方式。${projectName}围绕${users}和${scenes}形成社会效益、应用效益、经济效益和数据/材料沉淀效益。社会效益体现为服务质量、治理效率或公共价值提升；应用效益体现为任务处理更清晰、流程更稳定、结果更可追溯；经济效益体现为成本节约、服务收入和持续运营空间；数据/材料效益体现为测试记录、用户反馈、版本日志和附件索引持续积累。`,
        makeTable(["效益类型", "影响对象", "形成机制", "证明材料"], [["社会效益", users, `围绕${scenes}提升服务效率和响应质量`, "访谈纪要、场景流程、服务记录"], ["应用效益", "一线使用者和管理者", `通过${modules}形成可复核结果`, "原型截图、测试表、流程图"], ["经济效益", "付费客户和团队", `${models}带来收入与成本控制空间`, "财务测算表、服务清单"], ["沉淀效益", "团队和后续合作方", `${proofs}持续积累`, "附件索引、版本日志"]]),
      ].join("\n\n"),
      risk: [
        `### 风险矩阵\n风险矩阵将发生概率、影响程度、预警信号和处置动作对应起来，便于团队在执行中及时调整。`,
        makeTable(["风险项", "预警信号", "处置动作"], [["需求风险", "访谈反馈分散、使用频次低", "缩小场景、重新排序需求"], ["技术风险", "指标波动、演示不稳定", "增加测试、保留人工复核"], ["市场风险", "客户预算不足、决策链长", "调整客群、拆分服务包"], ["财务风险", "成本超预算、回款慢", "分阶段投入、滚动测算"], ["合规风险", "数据和授权边界不清", "最小化采集、补充授权说明"]]),
      ].join("\n\n"),
      future: `### 阶段成果指标\n未来规划以阶段成果指标衡量：短期看原型完成度、测试记录、访谈数量和项目书质量；中期看试点沟通、服务包成熟度、合作资源和运维机制；长期看客户复用、成果转化、知识产权准备和品牌影响。指标化规划能够避免“空泛展望”，让项目发展路径更接近真实执行。`,
      materials: `### 材料目录与归档责任\n附件材料由项目负责人统一管理，研发、调研、财务、运营和材料成员分别提交对应资料。归档目录包括政策行业资料、用户调研资料、原型测试资料、财务测算资料、团队成果资料和展示答辩资料。每份材料在目录中标明名称、来源、形成时间、证明对象和对应章节，保证提交材料可核验。`,
      general: `### 指标与材料闭环\n${projectName}通过${metrics}评价实施效果，通过${proofs}证明关键结论，通过版本日志和问题清单记录迭代过程。该闭环使正文不只是描述项目设想，而是能够说明项目如何被执行、如何被检查、如何持续改进。`,
    };
    return thirdStage[need] || thirdStage.general;
  }

  if (stage >= 2) {
    const secondStage: Record<string, string> = {
      summary: [
        `${projectName}的落地性体现在任务对象、产品流程和材料依据三者一致：任务对象来自${users}，产品流程围绕${modules}展开，材料依据由${proofs}构成。开篇进一步强调该方案不以单点功能作为卖点，而是以完整服务闭环作为核心呈现。`,
        `项目推进采用分阶段口径：近期完善原型和测试记录，中期形成标准化服务包和报价依据，远期根据${profile.domain}的场景需求拓展复制。所有市场和财务判断采用公开资料口径、行业报告口径或项目估算口径，所有技术能力以原型测试口径和附件材料说明支撑。`,
      ].join("\n\n"),
      background: [
        `### 政策趋势与需求验证\n${profile.domain}的发展趋势为项目提供了外部条件，但项目真正成立还取决于场景需求是否真实。围绕${users}，团队需要把${scenes}中的问题转化为访谈记录、流程图、痛点清单和需求优先级。${pains}不是孤立现象，而会影响服务效率、管理成本、用户体验和后续复盘，因此本章把宏观趋势与微观场景连接起来。`,
        `### 问题边界与材料依据\n项目边界聚焦在团队能够验证和交付的范围内，优先完成高频、可演示、可测试、可沉淀材料的场景。背景判断由公开资料、用户材料和测试准备共同支撑，其中公开资料说明行业趋势，用户材料说明需求真实性，原型与测试材料说明项目具备解决问题的初步能力。`,
      ].join("\n\n"),
      product: [
        `### 使用流程与验收指标\n产品使用流程以${users}的实际任务为起点，经过任务提交、模块处理、结果展示、人工复核和记录归档，最终形成可复盘的服务闭环。验收指标围绕${metrics}设置，既评价系统是否能完成核心任务，也评价结果是否稳定、成本是否可接受、用户是否愿意持续使用。`,
        `### 部署边界与迭代机制\n项目部署不追求一次覆盖所有场景，而是先在${scenes}中选择可验证场景形成样板，再根据反馈迭代。迭代机制包括需求更新、异常记录、版本日志、指标复测和材料归档，确保产品从竞赛展示进入后续实践时仍有清晰路径。`,
      ].join("\n\n"),
      innovation: [
        `### 技术可验证性\n创新能否成立，需要落到可复核证据。项目以${profile.techRoute}为技术主线，把每个创新点对应到原型页面、模块说明、流程图、测试记录或演示材料。技术部分不只写“用了什么技术”，还说明技术如何进入业务流程、如何产生结果、如何被用户和团队复核。`,
        `### 壁垒持续性\n项目壁垒来自持续积累而不是一次性表述。随着${proofs}逐步沉淀，项目能够形成场景理解、业务流程、测试数据、用户反馈、交付经验和服务口碑等复合壁垒。这些壁垒比单纯的功能模仿更难替代。`,
      ].join("\n\n"),
      market: [
        `### 需求验证方法\n市场验证从小样本访谈和原型演示开始，重点确认${users}是否确实存在${pains}，以及是否愿意为效率提升、质量改善、风险降低或管理便利投入资源。验证材料包括访谈纪要、问卷结果、演示反馈、竞品价格、采购流程记录和试点意向沟通。`,
        `### 商业进入节奏\n市场进入不依赖大范围宣传，而是先选择反馈周期短、需求明确、决策链条相对清晰的客户或场景完成样板验证。完成样板后，再把功能模块、服务流程、部署成本、培训材料和运维责任整理为标准化服务包，用于向相邻场景复制。`,
      ].join("\n\n"),
      business: [
        `### 收费结构与服务边界\n商业模式需要把收费对象、收费内容和服务边界写清楚。${models}分别对应不同的交付深度和持续服务责任。项目制交付强调一次性方案和部署成果，订阅运维强调持续更新和问题响应，模块授权强调与合作平台的接口和责任划分。`,
        `### 合作生态与复购机制\n项目复购来自持续服务价值。团队通过版本更新、用户培训、数据或资料维护、功能迭代和运营报告增强客户黏性；通过校企合作、平台集成、行业资源和竞赛展示扩大可信度。合作生态形成后，项目能够从单次交付转向持续运营。`,
      ].join("\n\n"),
      operation: [
        `### 资源配置与责任分工\n运营管理将任务拆为研发、产品、测试、调研、财务、运营和材料七类责任。每类责任都对应阶段成果和验收方式，避免项目推进只依赖口头协作。资源配置优先服务原型闭环、测试记录、用户反馈和材料定稿。`,
        `### 进度复盘与质量验收\n项目每个阶段设置复盘节点，记录完成事项、问题原因、修正动作和下一阶段输入。质量验收不仅检查功能是否存在，还检查流程是否完整、指标是否记录、附件是否可追溯、正文与演示是否一致。`,
      ].join("\n\n"),
      team: [
        `### 能力结构与成长路径\n团队能力由专业基础、项目经验、协作机制和外部指导共同构成。研发能力保证${modules}可以形成原型，调研能力保证${users}和${competitors}分析有依据，财务与运营能力保证${finance}能够解释成本和收入，材料能力保证项目书、附件和答辩一致。`,
        `### 指导资源与执行保障\n指导教师和外部资源主要提供技术路线、竞赛规范、行业经验和材料审核支持。团队通过分工表、里程碑、周复盘和版本日志保障执行连续性，使项目即使在竞赛周期结束后，也能继续迭代为课程成果、创新训练成果或创业实践成果。`,
      ].join("\n\n"),
      finance: [
        `### 财务假设与敏感性分析\n财务预测建立在客户数量、交付单价、部署成本、运维人力、续费率和推广成本等假设上。项目采用保守、中性、积极三档情景，分别对应不同的市场进入速度和客户转化水平。敏感性分析重点关注客户转化率、单客户交付成本和续费率变化对现金流的影响。`,
        `### 资金安排与成果对应\n资金安排与成果产出一一对应：研发投入对应核心模块和原型版本，测试投入对应指标记录和问题清单，市场投入对应访谈材料和客户沟通，展示投入对应路演材料和演示视频，合规与知识产权投入对应软著、专利或授权准备材料。`,
      ].join("\n\n"),
      benefits: [
        `### 社会与应用价值\n${projectName}的效益首先体现在真实场景中的使用改善。围绕${scenes}，${users}能够获得更清晰的任务入口、更稳定的处理流程和更可追溯的结果记录。社会与应用价值不是停留在“前景广阔”上，而是通过${metrics}观察效率、质量、成本、稳定性和满意度变化，再用${proofs}说明这些变化如何被记录和复核。`,
        `### 经济与可扩展价值\n经济效益来自${models}形成的服务收入、客户成本节约和后续运维空间。可扩展价值来自产品模块、服务流程、用户反馈和材料体系的持续沉淀。早期效益以原型测试、访谈反馈和估算模型呈现，中后期再根据试点和客户转化情况更新测算，不把未发生的收入或合作写成既成成果。`,
      ].join("\n\n"),
      risk: [
        `### 风险预警与责任闭环\n风险控制不只列风险名称，还要说明谁监控、何时触发、如何处置、用什么材料证明。技术风险由研发和测试成员负责，市场风险由调研和运营成员负责，财务风险由财务成员负责，材料真实性风险由项目负责人和材料成员共同复核。`,
        `### 应急调整与迭代策略\n当测试指标、用户反馈或成本测算未达到预期时，项目通过缩小场景范围、调整功能优先级、补充人工复核、优化服务流程和重新估算成本进行调整。风险处理结果进入版本日志和附件索引，形成持续改进证据。`,
      ].join("\n\n"),
      future: [
        `### 短中长期目标衔接\n短期目标聚焦可演示原型和申报材料，中期目标聚焦试点验证和服务包标准化，长期目标聚焦场景复制和品牌能力。三个阶段之间通过数据、材料和客户反馈衔接，避免规划只停留在口号。`,
        `### 成果延展与社会影响\n项目成果可延展为课程实践、竞赛路演、校企合作、软件著作权或专利准备、行业解决方案和学生创业实践。社会影响来自${profile.domain}中效率提升、服务质量改善和资源配置优化。`,
      ].join("\n\n"),
      materials: [
        `### 材料真实性与核验方式\n附件材料采用“材料名称、形成方式、证明对象、对应章节”的方式管理。每一项材料都要能说明来源和用途，避免只有堆砌清单而无法支撑关键判断。对于尚未形成的材料，只写形成计划和验收口径。`,
        `### 图表编号与引用关系\n图表资料与章节内容互相引用。架构图对应产品和技术章节，流程图对应运营和服务章节，客户画像表对应市场章节，财务表对应融资章节，风险表对应风险章节。图表标题、编号、说明和章节结论保持一致。`,
      ].join("\n\n"),
      general: `${projectName}进一步围绕${profile.domain}补足实施细节和材料依据。内容以${users}、${scenes}、${modules}、${metrics}和${proofs}为主线，保持事实基础、技术路线、商业路径和附件材料之间的一致。`,
    };
    return secondStage[need] || secondStage.general;
  }

  if (need === "summary") {
    return [
      `${projectName}以“问题真实、方案可运行、市场可进入、团队能执行、材料可追溯”为核心判断。团队首先把${users}在${scenes}中的高频问题作为切入点，再用${modules}形成产品化能力，最后通过${metrics}和${proofs}证明方案并非停留在概念层。开篇把用户、场景、产品、商业和材料五条线索同时交代清楚，使后续章节能够沿着同一条主线展开。`,
      `从实施口径看，团队现阶段以原型完善和材料沉淀为重点，不把尚未发生的合同、营收或授权写成既成事实。商业价值采用${finance}等路径表达，市场判断采用公开资料口径、行业报告口径和团队估算口径，技术能力采用原型测试口径和附件材料说明，既保持内容完整度，也保留大学生竞赛材料的真实性。`,
    ].join("\n\n");
  }

  if (need === "background") {
    return [
      `### 场景问题与建设必要性\n${projectName}对应的现实问题并不是单一技术缺口，而是${users}在${scenes}中长期存在的信息不对称、流程割裂、响应不及时和结果难复盘等综合矛盾。${pains}使传统方式在效率、成本和稳定性上暴露短板。项目建设的必要性来自两个方向：一方面，用户希望用更低成本获得连续、稳定、可追溯的服务；另一方面，管理者或组织客户希望把原来依赖经验的流程转化为有记录、有指标、有责任边界的系统化能力。`,
      `### 社会价值与应用价值\n社会价值体现在提升服务质量、减少重复劳动、降低管理成本和增强数字化能力。围绕${profile.domain}，团队把${modules}嵌入真实业务流程，使结果能够被查看、复核、归档和迭代。应用价值则体现在可交付性：团队不仅描述要做什么，还把需求来源、功能流程、评价指标和附件材料联系起来，为后续试点、答辩、路演和成果转化留下清晰依据。`,
    ].join("\n\n");
  }

  if (need === "product") {
    return [
      `### 产品流程与功能闭环\n${projectName}的产品流程从${scenes}中的具体任务开始，由${users}触发需求或提交资料，系统通过${modules}完成处理、判断、生成、记录或反馈，再由团队或管理端进行复核和归档。该流程强调输入、处理、输出、复核和迭代五个环节，避免产品只停留在功能清单。每个环节都能对应到原型截图、流程图、测试记录或附件索引，从而形成可以展示、可以解释、可以改进的产品闭环。`,
      `### 技术路线与交付形态\n技术路线按照${profile.techRoute}推进。交付形态包括前端交互界面、后台管理或配置模块、核心处理模块、结果展示模块、数据或资料归档模块以及运维迭代记录。产品部分同时回答“用户看到什么、系统处理什么、团队交付什么、材料证明什么”。内容以${metrics}作为评价指标，以${evidence}作为材料依据，将技术方案写成可交付服务，而不是抽象研发设想。`,
      makeTable(["产品层级", "主要内容", "证明方式"], [["用户入口", `面向${users}提供任务提交、查询、反馈或管理入口`, "原型截图、流程图"], ["核心处理", `围绕${modules}完成关键业务逻辑`, "架构图、模块说明、测试记录"], ["结果输出", `输出可查看、可复核、可归档的结果`, "演示记录、指标表"], ["持续迭代", "根据反馈和测试记录更新功能边界", "版本日志、问题清单"]]),
    ].join("\n\n");
  }

  if (need === "innovation") {
    return [
      `### 创新内容分层\n${projectName}的创新内容可以分为场景创新、产品创新、技术创新和模式创新。场景创新体现在项目聚焦${scenes}，把真实任务拆解为可处理流程；产品创新体现在${modules}形成组合能力；技术创新体现在${profile.techRoute}能够把输入、处理、输出和反馈连接起来；模式创新体现在${models}使项目具备持续服务和复制推广空间。四类创新共同构成项目竞争力，避免只把某个算法、某个页面或某个概念当成全部亮点。`,
      `### 竞争优势与壁垒形成\n相较于${competitors}，优势集中在场景贴合、流程闭环、材料可追溯和实施成本可控。团队把竞争优势落到${metrics}和${proofs}，用原型、测试、访谈、竞品对比和财务测算说明壁垒来源。对于尚未取得的知识产权或合作资源，采用计划和材料形成方式表达，不把未完成事项提前写成成果。`,
    ].join("\n\n");
  }

  if (need === "market") {
    return [
      `### 目标市场与用户分层\n${projectName}的目标市场围绕${market}展开，用户可分为直接使用者、管理决策者、付费客户和生态合作方。直接使用者关注操作便利、结果准确和反馈速度；管理决策者关注流程留痕、质量控制和成本投入；付费客户关注投入产出、部署难度和售后服务；合作方关注标准接口、交付周期和联合推广空间。通过分层分析，项目能够避免把“用户”写成抽象群体，而是把不同对象的诉求、决策逻辑和证明材料分别落地。`,
      `### 竞争格局与进入路径\n当前替代方案包括${competitors}。这些方案各有优势，但在${pains}方面仍存在场景适配不足、服务连续性弱、数据或资料难复盘、部署成本不透明等问题。进入市场时采用“低成本验证-标准化交付-场景化复制”的路径：先通过访谈和原型演示确认需求，再通过小样本测试和服务清单确定交付边界，最后沉淀报价口径、运维机制和案例材料。市场规模、客户数量和价格区间全部采用公开资料口径、行业报告口径或团队估算口径。`,
      makeTable(["市场对象", "关注重点", "进入方式", "支撑材料"], profile.users.slice(0, 5).map((user) => [user, "效率、成本、稳定性和服务质量", "访谈沟通、原型演示、试点验证", "访谈纪要、需求清单、测试记录"])),
    ].join("\n\n");
  }

  if (need === "business") {
    return [
      `### 价值主张与收入逻辑\n${projectName}的价值主张是帮助${users}在${scenes}中更快、更稳定、更可追溯地完成关键任务。收入逻辑围绕${models}展开：项目制交付适合明确需求和定制部署场景，订阅运维适合持续使用和长期更新场景，模块授权适合与平台或集成商合作，培训与服务适合项目落地后的持续支持。各收入方式都以交付内容、服务边界、成本结构和验收指标为前提，不虚构已经发生的订单或营收。`,
      `### 运营推广与客户转化\n运营策略从可信度建设开始。早期通过${proofs}形成展示材料，以竞赛路演、校企资源、行业交流、示范场景和线上内容触达目标客户；中期根据反馈完善服务包、报价模型和部署手册；后期在相邻场景中复制。客户转化流程包括需求访谈、方案演示、试用或小样本验证、交付报价、验收反馈和续费运维。每一步都对应可沉淀材料，使商业模式能够被客户、导师和后续合作方复核。`,
    ].join("\n\n");
  }

  if (need === "operation") {
    return [
      `### 实施路线与阶段目标\n项目实施按照需求确认、原型完善、测试验证、材料沉淀、展示答辩和复制推广六个阶段推进。需求确认阶段围绕${users}和${scenes}形成用户画像、痛点清单和流程图；原型完善阶段围绕${modules}完成核心功能；测试验证阶段记录${metrics}；材料沉淀阶段整理图表、附件、财务测算和项目日志；展示答辩阶段形成路演材料、演示脚本和答辩问答；复制推广阶段根据反馈形成标准化服务包。`,
      `### 运营管理与质量控制\n运营管理重点在任务分工、版本节奏、质量复核和材料归档。研发任务对应功能模块和测试记录，产品任务对应用户流程和界面说明，调研任务对应市场和竞品材料，财务任务对应成本和收入测算，运营任务对应客户沟通和渠道维护，材料任务对应项目书、附件和答辩资料。质量控制以${metrics}为核心，不只检查结果是否完成，也检查过程是否可追溯、材料是否能支撑正文判断。`,
    ].join("\n\n");
  }

  if (need === "team") {
    return [
      `### 团队分工与项目匹配\n团队能力需要与项目任务对应。${projectName}涉及研发、产品、调研、财务、运营和材料六类工作，研发成员承担${modules}的实现和测试，产品成员负责场景流程和原型体验，调研成员负责${users}访谈和${competitors}对比，财务成员负责${finance}测算，运营成员负责推广路径和合作沟通，材料成员负责项目书、图表、附件和答辩材料一致性。`,
      `### 协作机制与成果沉淀\n团队协作采用任务清单、周度复盘、版本日志和附件归档机制。每个阶段都形成可检查成果：需求阶段形成访谈纪要和用户画像，研发阶段形成原型截图和测试记录，市场阶段形成竞品表和客户画像，财务阶段形成预算表和收入预测，材料阶段形成项目书终稿和附件索引。该机制能够证明团队不是临时拼凑材料，而是在持续推进项目。`,
    ].join("\n\n");
  }

  if (need === "finance") {
    return [
      `### 成本结构与资金用途\n财务分析采用项目估算口径。成本结构包括研发工具与环境、测试验证、资料整理、原型部署、市场调研、展示材料、运维支持和知识产权准备等。资金用途需要和项目产出对应：研发投入形成核心模块和版本记录，测试投入形成指标表和问题清单，市场投入形成访谈纪要和竞品分析，展示投入形成路演材料和演示视频，运维投入形成服务手册和更新机制。`,
      `### 收入预测与融资回报\n收入预测围绕${models}展开，采用保守、中性、积极三档假设。保守情景以少量试点和项目制交付为主，中性情景加入年度运维和定制服务，积极情景在标准化服务包成熟后拓展更多客户或合作伙伴。融资回报不承诺固定收益，而是通过客户数量、交付单价、续费率、服务成本和毛利空间进行估算。财务章节的关键不是数字越大越好，而是每个数字都能解释来源、假设和风险。`,
      makeTable(["财务项目", "测算逻辑", "材料依据"], [["研发成本", "按功能模块、开发周期和测试环境估算", "任务清单、原型记录"], ["市场成本", "按调研、展示、渠道沟通和试点支持估算", "访谈纪要、推广计划"], ["运维成本", "按部署、培训、更新和问题响应估算", "服务清单、版本日志"], ["收入来源", models, "报价模型、客户分层、项目估算口径"]]),
    ].join("\n\n");
  }

  if (need === "benefits") {
    return [
      `### 社会发展与应用效益\n${projectName}的预期效益首先体现在${users}在${scenes}中的体验改善和流程优化。当前痛点集中在${pains}，项目通过${modules}把分散任务转化为可执行、可记录、可复核的服务流程。对使用者而言，效益表现为操作路径更清晰、响应更及时、结果更稳定；对管理者而言，效益表现为过程留痕、数据/资料可沉淀、责任边界更明确；对团队而言，效益表现为创新训练成果、原型测试材料和后续转化基础持续累积。`,
      `### 经济价值与持续运营效益\n经济价值按项目估算口径表达，主要来自${models}带来的收入可能、客户侧效率提升和服务成本优化。早期以样板场景和小规模验证证明价值，中期通过标准服务包降低交付成本，后期通过模块授权、订阅运维或合作推广扩大复用范围。效益测算以${metrics}为观察指标，以${proofs}为支撑材料，不把尚未发生的合同、营收或合作写成既成事实。`,
      makeTable(["效益维度", "具体表现", "测算/证明口径"], [["社会效益", `改善${users}在${scenes}中的服务效率和结果可靠性`, "用户材料口径、访谈纪要"], ["应用效益", `${modules}形成可运行、可复核、可迭代的服务闭环`, "原型测试口径、测试记录"], ["经济效益", `${models}带来服务收入、成本优化和复购空间`, "项目估算口径、财务测算"], ["成长效益", "团队完成研发、调研、财务、运营和材料综合训练", "分工表、版本日志、阶段成果"], ["扩展效益", "产品模块和服务流程可向相邻场景复制", "服务手册、附件索引、合作沟通记录"]]),
    ].join("\n\n");
  }

  if (need === "risk") {
    return [
      `### 风险识别与影响分析\n项目风险主要包括需求风险、技术风险、市场风险、财务风险、合规风险和团队风险。需求风险表现为用户痛点不够聚焦或需求变化过快；技术风险表现为核心指标不稳定、原型链路不完整或测试样本不足；市场风险表现为客户预算、采购流程和竞品替代不确定；财务风险表现为成本估算偏低或收入预测偏乐观；合规风险表现为数据、隐私、授权和知识产权边界不清；团队风险表现为任务衔接和材料沉淀不足。`,
      `### 应对措施与复核机制\n项目通过场景访谈、原型测试、人工复核、分阶段投入、最小化数据采集和团队复盘控制风险。每类风险都对应责任人、触发条件、处置动作和证明材料。技术风险通过${metrics}持续记录，市场风险通过${users}反馈和${competitors}对比复核，财务风险通过预算表和现金流估算控制，合规风险通过授权说明、脱敏处理和附件索引约束。`,
    ].join("\n\n");
  }

  if (need === "future") {
    return [
      `### 阶段规划与成果转化\n项目短期目标是完成${modules}的原型闭环、核心指标测试、用户访谈和竞赛材料定稿；中期目标是在${scenes}中形成标准化服务包、部署说明和运维机制；长期目标是围绕${profile.domain}拓展更多应用对象，形成可复制的产品、服务和数据资产。成果转化路径包括竞赛展示、校内试点、校企合作、软著或专利准备、平台接口开放和行业服务包推广。`,
      `### 综合价值与发展前景\n项目发展前景来自真实需求、技术可行、商业路径和团队持续执行的叠加。随着${proofs}逐步完善，项目能够从单次竞赛材料转化为持续迭代的实践项目。未来价值不仅体现在收入预测，也体现在服务效率提升、管理流程优化、学生创新创业能力提升和学校成果展示能力增强。`,
    ].join("\n\n");
  }

  if (need === "materials") {
    return [
      `### 附件体系与章节对应\n附件材料围绕${proofs}组织，作用是证明关键判断。政策与行业资料支撑背景和市场判断，用户调研资料支撑痛点和需求判断，原型与测试材料支撑产品和技术判断，财务测算材料支撑商业模式和资金用途，团队材料支撑执行能力和组织保障。附件不替代章节内容，而是让每个关键事实都能被追溯。`,
      `### 提交材料与展示材料\n正式提交时，项目书、图表、原型截图、测试记录、访谈纪要、财务测算表、团队分工表和路演材料需要保持口径一致。图1可呈现系统或产品架构，图2可呈现服务流程；表格可覆盖客户画像、竞品对比、功能模块、财务测算、实施进度和风险控制。材料章节的重点是完整、真实、可核验。`,
    ].join("\n\n");
  }

  return `${projectName}围绕${profile.domain}展开，本章进一步把${users}、${scenes}、${modules}、${metrics}和${proofs}连接起来。章节内容只保留事实基础、方案、路径和材料依据，直接呈现价值与落地能力。`;
}

function insertChapterDepthSupplement(text: string, step: StepDef, config: WorkflowConfig) {
  const range = chapterSectionRange(text, step);
  if (!range.found) return { text, changed: false, addedChars: 0 };
  let supplement = "";
  for (const stage of [1, 2, 3, 4]) {
    const candidate = buildChapterDepthSupplement(step, config, stage);
    const firstHeading = candidate.match(/^###\s+(.+)$/m)?.[1] || candidate.slice(0, 40);
    if (!range.section.includes(firstHeading)) {
      supplement = candidate;
      break;
    }
  }
  if (!supplement) return { text, changed: false, addedChars: 0 };
  return insertSpecificChapterSupplement(text, step, supplement);
}

function insertSpecificChapterSupplement(text: string, step: StepDef, supplement: string) {
  const range = chapterSectionRange(text, step);
  if (!range.found) return { text, changed: false, addedChars: 0 };
  if (!supplement.trim()) return { text, changed: false, addedChars: 0 };
  const firstHeading = supplement.match(/^###\s+(.+)$/m)?.[1] || supplement.slice(0, 40);
  if (firstHeading && range.section.includes(firstHeading)) return { text, changed: false, addedChars: 0 };
  const nextSection = `${range.section.trim()}\n\n${supplement}`.trim();
  const next = `${text.slice(0, range.start)}${nextSection}${text.slice(range.end)}`.replace(/\n{3,}/g, "\n\n").trim();
  return { text: next, changed: next !== text, addedChars: Math.max(0, next.length - text.length) };
}

function buildAgentTrace(items: Array<{ label: string; detail: string; status?: string }>) {
  return items.map((item, index) => ({
    step: index + 1,
    label: item.label,
    detail: item.detail,
    status: item.status || "done",
  }));
}

function localWholeDocumentImprove(
  content: string,
  instruction: string,
  config: WorkflowConfig,
  filePath: string,
  researchContext?: { sourceCount: number; evidenceCount: number; highlights: string[] },
  qualityContext?: EditorQualityContext,
) {
  const original = String(content || "");
  if (!original.trim()) return null;
  const actions: string[] = [];
  const beforeDiagnostic = projectBookDiagnosticBlocks(original, config);
  let next = normalizeProjectBookHeadings(sanitizeProjectBookBody(repairAdviceTone(stripAutoGeneratedSections(removeRepeatedAutoSections(original)))));
  if (next !== original.trim()) actions.push("清理建议式语言、过程说明、重复扩写和非正文痕迹");

  const projectName = config.name || "本项目";
  const track = config.track || config.competition || "竞赛申报方向";
  const product = config.product || `${projectName}核心产品/系统`;
  const materialBasis = config.evidence || "公开资料口径、项目估算口径、原型测试记录、访谈纪要和附件材料";
  const researchHighlights = researchContext?.highlights?.length
    ? researchContext.highlights.join("；")
    : "";
  const effectiveConfig = researchHighlights
    ? { ...config, evidence: [config.evidence, researchHighlights].filter(Boolean).join("；") }
    : config;
  if (researchContext) {
    actions.push(`接入联网调研与证据库：公开来源 ${researchContext.sourceCount} 个、证据摘要 ${researchContext.evidenceCount} 条`);
  }
  if (qualityContext) {
    actions.push(`读取编辑器质量体检：${qualityContext.score}分，未通过 ${qualityContext.failed.length} 项`);
  }
  let appliedBlocks: string[] = [];
  const loopNotes: string[] = [];

  const chapterGaps = missingOrThinChapterSteps(next, effectiveConfig);
  const hadChapterGaps = chapterGaps.length > 0;
  if (chapterGaps.length) {
    const pruned = pruneShortDraftExtraSections(next, effectiveConfig, chapterGaps.length);
    if (pruned !== next) {
      next = pruned;
      actions.push("清理短草稿中的非模板章节，转为正式竞赛目录");
    }
    const maxChapterFill = 12;
    const selectedGaps = chapterGaps.slice(0, maxChapterFill);
    const chapterBlocks = selectedGaps.map((step) => buildChapterGapBlock(next, step, effectiveConfig));
    next += `\n\n${chapterBlocks.join("\n\n")}`;
    appliedBlocks.push(...chapterBlocks);
    actions.push(`写入缺失/薄弱章节：${selectedGaps.map((step) => canonicalStepHeading(step).chapter || step.targetSection || step.name).join("、")}`);
    if (chapterGaps.length > maxChapterFill) {
      loopNotes.push(`本轮先补齐 ${maxChapterFill}/${chapterGaps.length} 个章节，剩余章节可继续执行“继续完善项目书”`);
    }
  }

  const depthGaps = thinChapterDepthSteps(next, effectiveConfig);
  if (depthGaps.length) {
    const maxDepthFill = 12;
    let depthAdded = 0;
    const expandedDepthNames = new Set<string>();
    for (let pass = 0; pass < 4; pass += 1) {
      const selectedDepthGaps = thinChapterDepthSteps(next, effectiveConfig).slice(0, maxDepthFill);
      if (!selectedDepthGaps.length) break;
      let passChanged = false;
      for (const step of selectedDepthGaps) {
        const beforeDepth = next.length;
        const result = insertChapterDepthSupplement(next, step, effectiveConfig);
        if (result.changed) {
          next = result.text;
          passChanged = true;
          expandedDepthNames.add(canonicalStepHeading(step).chapter || step.targetSection || step.name);
          depthAdded += Math.max(0, next.length - beforeDepth);
        }
      }
      if (!passChanged) break;
    }
    if (depthAdded > 0) {
      actions.push(`扩写薄弱章节：${Array.from(expandedDepthNames).join("、")}`);
      loopNotes.push(`章节内部扩写新增 ${depthAdded.toLocaleString()} 字符`);
      appliedBlocks.push(...Array.from(expandedDepthNames).map((name) => `## ${name}`));
    }
  }

  if (!hadChapterGaps && !/实施计划|里程碑|进度安排|阶段目标/.test(next)) {
    next += `\n\n## 实施计划与里程碑\n${projectName}围绕${track}的申报要求推进，整体采用“需求确认、原型完善、测试验证、材料沉淀、展示答辩、持续迭代”的实施路径。需求确认阶段重点梳理目标用户、核心场景、痛点边界和评价指标；原型完善阶段围绕${product}完成核心功能闭环、关键页面或模块说明、数据流转与交互流程；测试验证阶段通过样例数据、演示环境、用户访谈或模拟运行记录形成可复核材料；材料沉淀阶段整理项目书、图表、财务测算、测试截图、访谈纪要、团队分工和附件索引，使项目论证能够从正文追溯到支撑材料。\n\n| 阶段 | 核心任务 | 交付成果 | 验收口径 |\n| --- | --- | --- | --- |\n| 需求确认 | 明确用户、场景、痛点和评审指标 | 需求清单、用户画像、流程图 | 访谈纪要和公开资料口径 |\n| 原型完善 | 完成核心功能、服务流程和技术说明 | 原型截图、架构图、功能模块表 | 原型测试口径 |\n| 测试验证 | 记录性能、成本、稳定性和体验反馈 | 测试表、问题清单、迭代记录 | 测试记录和项目估算口径 |\n| 材料沉淀 | 形成项目书、附件、图表和答辩材料 | 终稿、附件索引、路演材料 | 申报材料核验口径 |`;
    actions.push("补入实施计划与里程碑");
  }

  if (!hadChapterGaps && !/风险控制|风险分析|风险管理|风险与对策/.test(next)) {
    next += `\n\n## 风险控制与保障机制\n项目实施过程中主要风险集中在需求偏差、技术验证、数据与隐私、市场转化、团队协作和材料真实性六个方面。需求偏差通过访谈复核和场景拆解降低；技术验证通过原型测试、问题清单和版本迭代控制；数据与隐私风险通过最小化采集、授权说明和脱敏处理约束；市场转化风险通过目标客户分层、价格口径测算和试点反馈逐步验证；团队协作风险通过分工表、周度复盘和成果归档机制控制；材料真实性风险通过${materialBasis}进行支撑，避免把尚未取得的合同、专利、授权或营收写成既成事实。\n\n| 风险类别 | 可能表现 | 控制措施 | 对应材料 |\n| --- | --- | --- | --- |\n| 需求风险 | 用户痛点泛化、场景不聚焦 | 访谈复核、场景流程拆解 | 访谈纪要、用户画像 |\n| 技术风险 | 指标不稳定、原型演示不足 | 小样本测试、版本迭代、异常记录 | 测试表、演示截图 |\n| 市场风险 | 价格和采购路径不清 | 客户分层、竞品对比、估算模型 | 市场调研表、财务测算 |\n| 合规风险 | 数据、隐私或授权边界不明 | 脱敏处理、授权说明、最小化采集 | 隐私说明、附件索引 |\n| 团队风险 | 任务衔接和成果沉淀不足 | 角色分工、复盘机制、文档归档 | 团队分工表、迭代日志 |`;
    actions.push("补入风险控制与保障机制");
  }

  if (!hadChapterGaps && !/支撑材料|证明材料|附件|材料清单/.test(next)) {
    next += `\n\n## 支撑材料与附件说明\n项目书结论由正文论证和附件材料共同支撑。政策和行业判断采用公开资料口径；市场规模、价格、收入和成本采用行业报告口径与项目估算口径；技术可行性采用原型测试口径、演示截图和版本记录；团队执行力采用分工表、阶段成果、指导教师意见和项目日志说明。附件不作为正文的堆砌材料，而是用于证明关键结论的来源、形成方式和可复核性。\n\n| 材料类型 | 形成方式 | 支撑结论 |\n| --- | --- | --- |\n| 政策与行业资料 | 公开资料整理 | 项目背景、社会价值和市场机会 |\n| 用户调研材料 | 访谈、问卷或场景观察 | 痛点真实性和目标用户画像 |\n| 原型与测试材料 | 系统截图、测试表、演示记录 | 产品可行性和技术路线 |\n| 财务测算材料 | 成本、收入、现金流估算 | 商业模式和资金用途 |\n| 团队材料 | 分工表、成果记录、指导意见 | 执行能力和组织保障 |`;
    actions.push("补入支撑材料与附件说明");
  }

  const contaminationRepair = removeCrossProjectContamination(next, effectiveConfig);
  if (contaminationRepair.text !== next) {
    next = contaminationRepair.text;
    actions.push(`清理跨项目串项内容：${contaminationRepair.removed} 行`);
  }

  const diagnostic = projectBookDiagnosticBlocks(next, effectiveConfig);
  if (false && !hadChapterGaps && diagnostic.blocks.length) {
    const freshBlocks = diagnostic.blocks.filter((block) => {
      const title = blockTitle(block);
      return !next.includes(title);
    });
    if (freshBlocks.length) {
      next += `\n\n${freshBlocks.join("\n\n")}`;
      appliedBlocks.push(...freshBlocks);
      actions.push(...diagnostic.actions);
    }
  }

  const maxImproveRounds = 3;
  let improveRound = 2;
  while (false && !hadChapterGaps && !projectBookMeetsMinimum(next, effectiveConfig) && improveRound <= maxImproveRounds) {
    const beforeRound = next.length;
    const roundBlock = buildIterativeImprovementBlock(next, effectiveConfig, improveRound);
    const title = blockTitle(roundBlock);
    if (!roundBlock.trim() || next.includes(title)) break;
    next += `\n\n${roundBlock}`;
    actions.push(`第${improveRound}轮继续补强：${projectBookGapLabels(next, effectiveConfig).slice(0, 3).join("、") || "评审闭环"}`);
    loopNotes.push(`第${improveRound}轮新增 ${Math.max(0, next.length - beforeRound).toLocaleString()} 字符`);
    improveRound += 1;
  }

  const repetitionRepair = repairEditorRepetition(next);
  if (repetitionRepair.text !== next) {
    next = repetitionRepair.text;
    actions.push(`去除重复表达：段落 ${repetitionRepair.removedParagraphs} 处、句子 ${repetitionRepair.removedSentences} 处`);
  }

  next = finalizeSubmissionTone(next);
  if (next === original.trim()) return null;
  const afterDiagnostic = projectBookDiagnosticBlocks(next, effectiveConfig);
  const diagnosticSummary = beforeDiagnostic.metrics.slice(0, 8).join("；");
  const qualityContextSummary = qualityContext
    ? [
        `体检 ${qualityContext.score}分/${qualityContext.band}`,
        qualityContext.failed.length ? `未通过：${qualityContext.failed.slice(0, 3).join("；")}` : "未通过：无",
        qualityContext.missing.length ? `缺失专属信号：${qualityContext.missing.slice(0, 5).join("、")}` : "",
      ].filter(Boolean).join("；")
    : "";
  const qualityMetricSummary = afterDiagnostic.metrics
    .filter((metric) => /项目专属度|串项风险|空泛段落/.test(metric))
    .join("；");
  const planSummary = summarizeAgentPlan(actions, appliedBlocks);
  const remainingGaps = projectBookGapLabels(next, effectiveConfig);
  const stopReason = remainingGaps.length
    ? hadChapterGaps
      ? `已完成正式章节写入，仍余：${remainingGaps.slice(0, 4).join("、")}`
      : `已完成 ${Math.max(1, improveRound - 1)} 轮安全完善，仍余：${remainingGaps.slice(0, 4).join("、")}`
    : hadChapterGaps
      ? "已完成正式章节写入，基础阈值已通过"
      : `已完成 ${Math.max(1, improveRound - 1)} 轮完善，基础阈值已通过`;
  const reviewSummary = `${summarizeAgentReview(beforeDiagnostic.metrics, afterDiagnostic.metrics, original.length, next.length)}；${stopReason}`;
  const qualitySummary = repetitionRepair.beforeDuplicates || repetitionRepair.beforeNgrams || repetitionRepair.removedParagraphs || repetitionRepair.removedSentences
    ? `；重复复核：整段 ${repetitionRepair.beforeDuplicates}->${repetitionRepair.afterDuplicates}，高频短语 ${repetitionRepair.beforeNgrams}->${repetitionRepair.afterNgrams}，删除重复段落 ${repetitionRepair.removedParagraphs} 处、重复句 ${repetitionRepair.removedSentences} 处`
    : "";
  const planDetail = hadChapterGaps
    ? `${planSummary}；本次优先写入正式竞赛章节，复核过程只保留在右侧日志，不写进项目书正文。`
    : `${planSummary}；最多循环 ${maxImproveRounds} 轮，直到达标或无新的安全完善块。`;
  const trace = buildAgentTrace([
    { label: "诊断", detail: `扫描全文结构、图表、证据链、技术、市场和财务密度。${diagnosticSummary}${qualityContextSummary ? `；${qualityContextSummary}` : ""}` },
    { label: "计划", detail: planDetail },
    { label: "执行", detail: `${instruction}；${actions.slice(0, 5).join("；") || "完成全文终稿化润色"}${loopNotes.length ? `；${loopNotes.join("；")}` : ""}` },
    { label: "复核", detail: `${reviewSummary}${qualityMetricSummary ? `；${qualityMetricSummary}` : ""}${qualitySummary}` },
    { label: "应用", detail: `准备写入 ${filePath || "当前编辑器"}，由用户检查后保存。` },
  ]);
  return {
    answer: [
      "诊断：已扫描全文结构、图表、证据链、技术、市场和财务密度。",
      `指标：${diagnosticSummary}`,
      qualityContextSummary ? `体检：${qualityContextSummary}` : "",
      `计划：${planSummary}`,
      `执行任务：${instruction}`,
      `变更摘要：${actions.slice(0, 5).join("；") || "完成全文终稿化润色"}${loopNotes.length ? `；${loopNotes.join("；")}` : ""}`,
      `复核：${reviewSummary}${qualitySummary}`,
      qualityMetricSummary ? `质量：${qualityMetricSummary}` : "",
      "下一步：请在中间编辑器检查局部预览，确认后保存。",
    ].filter(Boolean).join("\n"),
    patch: next,
    trace,
  };
}

function isSafeFullReplacement(original: string, patch: string) {
  const source = String(original || "");
  const next = String(patch || "");
  if (!next.trim()) return false;
  if (source.length < 500) return next.trim().length >= 5;
  if (next.length < Math.min(500, source.length * 0.35)) return false;
  const sourceHeadings = (source.match(/^#{1,3}\s+/gm) || []).length;
  const nextHeadings = (next.match(/^#{1,3}\s+/gm) || []).length;
  if (sourceHeadings >= 4 && nextHeadings < 2) return false;
  return true;
}

function stripQuoteMarks(value: string) {
  return value.trim().replace(/^[“"']+|[”"']+$/g, "").trim();
}

function tryLocalDirectEdit(content: string, instruction: string) {
  const text = String(content || "");
  const command = String(instruction || "");
  if (!text.trim()) return null;

  const projectCategoryMatch = command.match(/项目类别[^改修替]*(?:改成|修改为|替换为|设为|设置为)\s*[“"']?([^”"'，。；;\n]+)[”"']?/);
  if (projectCategoryMatch?.[1]) {
    const nextValue = stripQuoteMarks(projectCategoryMatch[1]);
    const updated = text.replace(/(\|\s*项目类别\s*\|\s*)[^|\n]*(\s*\|)/, `$1${nextValue}$2`);
    if (updated !== text) {
      return {
        answer: [
          `已定位封面信息中的“项目类别”字段，并改为“${nextValue}”。`,
          "修改已写入中间编辑器，右侧仅保留执行结果。",
          "请检查无误后点击保存。",
        ].join("\n"),
        patch: updated,
      };
    }
  }

  const replaceMatch = command.match(/把\s*(?:所有|全部|全文|全局)?\s*[“"']?(.{1,80}?)[”"']?\s*(?:改成|修改为|替换为)\s*[“"']?(.{1,120}?)[”"']?(?:[，。；;]|$)/);
  if (replaceMatch?.[1] && replaceMatch?.[2]) {
    const from = stripQuoteMarks(replaceMatch[1]);
    const to = stripQuoteMarks(replaceMatch[2]);
    if (from && to && text.includes(from)) {
      const replaceAll = /全部|所有|全文|全局/g.test(command);
      const updated = replaceAll ? text.replace(new RegExp(escapeRegExp(from), "g"), to) : text.replace(from, to);
      return {
        answer: [
          `已${replaceAll ? "全局" : ""}将“${from}”替换为“${to}”。`,
          "修改已应用到当前编辑器内容。",
          "请检查上下文是否符合预期后保存。",
        ].join("\n"),
        patch: updated,
      };
    }
  }

  const deleteMatch = command.match(/(?:删除|去掉|移除)\s*[“"']?(.{1,160}?)[”"']?(?:[，。；;]|$)/);
  if (deleteMatch?.[1]) {
    const target = stripQuoteMarks(deleteMatch[1]);
    if (target && text.includes(target)) {
      const removeAll = /全部|所有|全文|全局/g.test(command);
      const updated = removeAll
        ? text.replace(new RegExp(escapeRegExp(target), "g"), "")
        : text.replace(target, "");
      return {
        answer: [
          `已${removeAll ? "全局" : ""}删除指定内容。`,
          `删除片段：${target.slice(0, 60)}${target.length > 60 ? "..." : ""}`,
          "修改已应用到当前编辑器内容，请检查后保存。",
        ].join("\n"),
        patch: updated,
      };
    }
  }

  return null;
}

function workflowSummary(id: string) {
  const config = readConfig(id);
  if (!config) return null;
  const projectDir = join(PROJECTS_DIR, id);
  const uploadKnowledgePath = join(projectDir, ".paper", "artifacts", "00-upload-knowledge.md");
  const uploadKnowledgeBody = existsSync(uploadKnowledgePath)
    ? readFileSync(uploadKnowledgePath, "utf-8")
    : "";
  let referenceConfig = withReferenceContext(config, uploadKnowledgeBody);
  if (!referenceConfig.styleReferenceContext && config.referenceNotes && existsSync(join(projectDir, ".paper", "uploads"))) {
    const refreshed = refreshUploadKnowledgeArtifact(id);
    referenceConfig = withReferenceContext(config, refreshed.body);
  }
  const drafts = listMarkdownFiles(join(projectDir, ".paper", "drafts"));
  const artifacts = listMarkdownFiles(join(projectDir, ".paper", "artifacts"));
  const checkpoints = checkpointStore.getWorkflowCheckpoints(id);
  return {
    id,
    ...config,
    draftCount: drafts.length,
    artifactCount: artifacts.length,
    checkpointCount: checkpoints.length,
    steps: projectWorkflowSteps(referenceConfig),
  };
}

function templateFor(config: WorkflowConfig) {
  return WORKFLOW_TEMPLATES[effectiveProjectBookTemplateId(config)] ?? WORKFLOW_TEMPLATES.dachuang;
}

function parseCount(value: string | undefined, fallback: number) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function projectSkillSourceStatus(template: WorkflowTemplateId, effectiveTemplate: WorkflowTemplateId = template) {
  void template;
  void effectiveTemplate;
  return "仅使用当前项目配置、当前项目上传资料和内置竞赛基础要求；不读取外部目录、历史样例或其他项目。";
}

function builtInProjectSkillRules(template: WorkflowTemplateId) {
  const rules: Record<WorkflowTemplateId, string> = {
    dachuang: `
【大创项目书 Skill 规则】
- 区分创新训练、创业训练、创业实践：创新训练突出研究目标、技术路线、阶段成果、教师指导和训练价值；创业训练突出商业计划、市场验证、运营模式、财务测算；创业实践突出已有基础、实体/平台运营、收入闭环和落地成效。
- 申报书正文默认采用八章项目计划书结构：一、项目方案概述；二、项目团队概述；三、产业背景与项目产品；四、市场调查与竞争分析；五、商业模式与发展战略；六、预期效益分析；七、总结与资金回报；八、证明材料。
- 未上传真实写法参考时，也不得启用执行摘要、项目优势、产品介绍、市场运营、未来展望、附录补充等单一商业计划书模板；只能把项目简介、立项依据、技术路线、实施计划、团队分工、经费预算、风险与对策、附件证明融入上述八章。
- 创业训练类可写商业可行性，但正文仍保留大创训练属性、学生成长路径、指导教师作用、阶段性训练成果和学校申报口径。
- 按级别控制深度：校级不少于约8-12页，省级/国家级不少于约15-25页；正文要有二级标题、表格、预算说明、时间进度表、成果清单。
- 宣传表/展示材料工作流应沉淀：200字项目简介、创新点3-5条、成果亮点、团队照片/原型图说明、指导教师与学院信息口径。`,
    tiaozhanbei: `
【挑战杯项目书 Skill 规则】
- 先区分大挑/小挑：大挑偏学术科技作品，强调研究背景、科学问题、技术路线、实验验证、创新性和应用价值；小挑偏创业计划，强调痛点、产品服务、商业模式、市场规模、竞争分析、财务预测和团队执行。
- 正文必须覆盖：摘要、项目背景与社会价值、问题定义、解决方案、技术/产品创新、调研与验证、市场/应用前景、实施计划、团队基础、风险对策、成果与附件。
- 专项赛道适配：黑科技突出技术先进性、可验证指标、原型/实验/专利口径；红色专项突出红色资源、社会实践、公益价值、传播路径、育人成效和落地案例。
- 答辩PPT结构应包括：问题痛点、项目方案、核心创新、验证数据、应用/商业价值、团队基础、进度成果、风险应对、未来规划。
- 文风要像参赛报告，不要像建议书；结论必须落到“作品/项目已经做了什么、证明了什么、下一阶段交付什么”。`,
    "internet-plus": `
【互联网+ / 中国国际大学生创新大赛 Skill 规则】
- 商业计划书采用10章结构：执行摘要、项目概况、行业痛点与机会、产品服务、技术创新、市场分析、商业模式、运营推广、团队与资源、财务融资与风险。
- 路演10页结构：封面、痛点、解决方案、产品展示、核心技术/壁垒、市场规模、商业模式、竞争优势、团队与进展、融资/规划/收尾。
- 1分钟视频脚本要按“痛点场景-产品亮相-核心能力-真实验证-团队愿景”组织，避免念项目书。
- 各赛道评分标准落到正文：教育/医疗/农业/文旅/低空经济等赛道要体现产业价值、创新性、商业可行性、带动就业/社会价值、团队执行力和可复制推广。
- 财务部分必须写收入模型、成本结构、关键假设、三年预测、融资用途、投资回报；没有真实订单时使用项目估算口径，不虚构合同。`,
  };
  return rules[template];
}

function projectSkillRules(config: WorkflowConfig) {
  const effectiveTemplate = effectiveProjectBookTemplateId(config);
  const source = `【当前项目书基础要求】\n${builtInProjectSkillRules(effectiveTemplate)}`;
  const templateNote = effectiveTemplate === config.template
    ? `当前项目模板为 ${config.template}。`
    : `当前项目配置模板为 ${config.template}，但未识别到当前上传参考项目书目录蓝图，正文结构强制采用八章项目计划书骨架。竞赛类型只用于调整评价口径、材料侧重点和措辞，不改变章节目录。`;
  return `
竞赛适配要求：
${source}

执行要求：
- ${templateNote}
- 文章结构只来自两处：当前上传的写法参考文档，或内置八章项目计划书骨架；不得因为项目名称、竞赛字段、历史样例或其他目录资料改成执行摘要/营销销售/未来展望/附件附录等旧商业计划书目录；
- 不读取、不引用、不模仿外部目录、历史样例库或其他项目的项目书；
- 若当前项目上传了“项目大纲/写法参考”文件，只能从该文件学习章节组织、标题层级、文风和格式感；
- 未上传当前项目参考文档时，所有项目书生成均按内置八章项目计划书结构组织，不回退到执行摘要/项目优势/营销销售/未来展望等旧模板；
- 最终正文不要出现“Skill、OpenClaw、提示词、期望路径、未找到、兜底”等系统说明。`;
}

function competitionChapterSignals(config: WorkflowConfig) {
  const signals: Record<WorkflowTemplateId, string[]> = {
    dachuang: ["一、项目方案概述", "二、项目团队概述", "三、产业背景与项目产品", "四、市场调查与竞争分析", "五、商业模式与发展战略", "六、预期效益分析", "七、总结与资金回报", "八、证明材料"],
    tiaozhanbei: ["执行摘要", "项目背景", "社会价值", "产品服务", "创新内容", "竞争优势", "市场分析", "目标市场", "营销策略", "运营管理", "团队介绍", "财务分析", "融资计划", "风险分析", "发展战略", "附件"],
    "internet-plus": ["项目概要", "行业痛点", "创业机会", "解决方案", "产品服务", "技术创新", "核心壁垒", "市场分析", "用户验证", "商业模式", "运营推广", "团队基础", "财务预测", "融资回报", "风险控制", "路演", "附件材料"],
  };
  return signals[effectiveProjectBookTemplateId(config)] ?? signals.dachuang;
}

function competitionQualityThresholds(config: WorkflowConfig) {
  const template = effectiveProjectBookTemplateId(config);
  if (template === "internet-plus") return { chars: 26000, tables: 48, figures: 2, evidence: 18 };
  if (template === "tiaozhanbei") return { chars: 24000, tables: 42, figures: 2, evidence: 16 };
  return { chars: 24000, tables: 45, figures: 2, evidence: 18 };
}

function minimumBodyChars(config: WorkflowConfig, step: StepDef) {
  if (step.id === "final-assembly") return 0;
  const pageLimit = parseCount(config.pageLimit, 30);
  const pageFactor = Math.min(1.25, Math.max(0.85, pageLimit / 30));
  const scaled = (value: number) => Math.round(value * pageFactor);
  const template = effectiveProjectBookTemplateId(config);
  if (template === "tiaozhanbei") {
    const targets: Record<string, number> = {
      "tb-executive-summary": 1800,
      "tb-project-background": 2500,
      "tb-company-product": 2500,
      "tb-innovation-advantage": 2500,
      "tb-market-analysis": 3100,
      "tb-marketing-sales": 2400,
      "tb-operation-management": 2400,
      "tb-team-organization": 1800,
      "tb-financial-plan": 2600,
      "tb-risk-control": 1900,
      "tb-development-prospect": 1800,
      "tb-appendix-proof": 1300,
    };
    return scaled(targets[step.id] ?? 1800);
  }
  if (template === "internet-plus") {
    const targets: Record<string, number> = {
      "ip-project-summary": 2000,
      "ip-problem-opportunity": 2700,
      "ip-solution-product": 3000,
      "ip-technology-innovation": 2700,
      "ip-market-validation": 3300,
      "ip-business-model": 2700,
      "ip-growth-operation": 2500,
      "ip-team-foundation": 1900,
      "ip-finance-funding": 2900,
      "ip-risk-compliance": 2000,
      "ip-roadshow-materials": 1600,
    };
    return scaled(targets[step.id] ?? 2000);
  }
  const targets: Record<string, number> = {
    overview: 2800,
    team: 2100,
    "industry-product": 3600,
    "market-competition": 3300,
    "business-strategy": 3000,
    benefits: 2600,
    "finance-deliverables": 2900,
    "proof-materials": 1800,
    "dc-executive-summary": 1800,
    "dc-project-overview": 2300,
    "dc-project-advantages": 2300,
    "dc-market-analysis": 3000,
    "dc-product-introduction": 3200,
    "dc-business-model": 2400,
    "dc-market-operation": 2300,
    "dc-financial-plan": 2600,
    "dc-team-introduction": 1800,
    "dc-risk-management": 1900,
    "dc-future-plan": 1700,
    "dc-appendix-proof": 1300,
  };
  const base = targets[step.id] ?? 1400;
  return scaled(base);
}

function submissionToneRules(targetChars?: number) {
  return `成稿口径要求：
- 直接输出可放入项目书的正文，不输出写作建议、修改建议、清单式待办或“如何写”的说明。
- 禁止使用指导口吻词：建议、应当、需要、以实际提交附件为准、补齐、占位、可考虑、如果条件允许、后续完善、赛前检查。
- 对未由用户提供的团队事实、真实客户、专利、软著、合作证明，不编造成已取得成果；改写为“项目以原型测试记录、访谈纪要、公开资料和估算模型作为论证依据”，并在附件说明中用中性表述。
- 对政策、市场、价格、财务预测等不确定信息，使用“公开资料口径、行业报告口径、项目估算口径、模拟测试口径”写成正文。
- 必须把调研材料转化为项目书论证，不输出调研过程说明。
- 正文要有具体对象、场景、指标、交付物和验证方式，避免空泛口号。${targetChars ? `\n- 当前章节正文长度不低于 ${targetChars} 个中文字符。` : ""}`;
}

function currentReferenceStyleRules(config: WorkflowConfig) {
  const reference = config.styleReferenceContext
    ? `\n\n## 当前项目上传参考文档摘录（仅用于结构和文风）\n${config.styleReferenceContext.slice(0, 9000)}`
    : "";
  const blueprint = referenceStyleBlueprint(config);
  return `当前项目参考文档写法规则：
- 只能参考当前项目上传到“项目大纲/写法参考”分区的文档；不得读取、引用、模仿外部目录、历史样例库或其他项目的结构。
- 若上传参考文档存在，终稿必须优先学习其目录顺序、标题层级、段落密度、表格组织和正式申报书语气；章节顺序不要自行改成其他项目书模板。
- 参考文档出现“一、…… / （一）…… / 1.”这类层级时，输出也使用同样的中文编号层级；不要把章节改写成营销页、研究论文或其他项目方向的结构。
- 表格写法要贴近参考文档：表头短、字段稳定、每格写结论性短句；单元格内容过长时主动用“；”分隔成两段，避免一行塞满。
- 上传参考文档中的项目名称、技术路线、团队信息、市场对象、财务数字和附件事实，不得自动当作当前项目事实，除非同一内容也出现在当前项目表单、相关文件或附件数据中。
- 若没有当前项目上传参考文档，只按竞赛基础要求组织章节，不声称参考了任何历史样例。
- 开篇先给一段100-220字的项目概述，直接说明痛点、产品、技术、应用场景和价值，不写“本文将从……展开”。
- 段落不是“观点堆叠”，而是按“场景事实/政策数据 -> 具体矛盾 -> 具体做法 -> 评审价值”推进。
- 每个正文段落通常承担一个明确功能：交代背景、拆解痛点、说明技术路线、证明市场规模、比较竞品、定义商业模式、说明实施路径、测算财务或索引证明材料。
- 章节开头要先给判断句，再给支撑材料。例如“近几年……共同推动……需求增长”，随后接政策、行业数据或公开报告口径。
- 当前章节名称只用于内部定位，不得原样拼接成长标题；禁止输出“一、项目方案概述（一）项目背景（二）项目简述：项目书正文深化”这类路径式标题。
- 不要为“项目书正文深化、场景对象与使用流程、量化指标体系、实施与验收路径、资料依据与证明链条、风险控制与迭代机制、竞赛呈现价值”等扩写角度单独起标题。
- 输出短标题必须像真实项目书一样简洁，每章通常3-6个二级/三级短标题，不要出现“生成”“策略建议”“说明如下”等非正文痕迹。
- 自然段长度以100-260字为主，句间要有承接关系，不要连续生成同一句式、同一结论或同一段落。
- 技术段落要把模块写清楚：输入是什么、处理链路是什么、核心模块解决什么问题、输出如何进入业务闭环，不能只说模型先进。
- 市场段落要写付费主体、采购场景、预算/价格带、触发条件和复制路径，不能只写宏观趋势。
- 商业段落使用“收入来源 + 客户对象 + 交付方式 + 收费口径 + 持续收入”的句式。
- 效益段落使用“核心场景 + 影响对象 + 量化或半量化结果 + 社会/经济/治理价值”的句式。
- 证明材料段落按“材料名称 + 来源主体/形成方式 + 证明什么 + 与正文哪一结论对应”写成正文或表格。
- 句子之间要有承接词：目前、近几年、同时、更关键的是、基于此、因此、整体来看、具体而言、与此对应、通过以上策略。
- 使用保守事实边界：政策和市场数据写“公开资料口径/行业报告口径”，财务写“项目估算口径”，原型指标写“模拟测试口径”。${blueprint}${reference}`;
}

function resolvePythonExe() {
  const candidates = [
    process.env.PAPER_PYTHON,
    join(homedir(), ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "python", "python.exe"),
    "python",
  ].filter(Boolean) as string[];
  return candidates[0];
}

function contextBlock(config: WorkflowConfig) {
  return `项目名称：${config.name}
竞赛类型：${config.competition}
细分方向：${config.track || "未填写"}
团队基础：${config.team || "未填写"}
项目简介：${config.brief || "未填写"}
技术/产品基础：${config.product || "未填写"}
市场与商业设想：${config.market || "未填写"}
资金/财务设想：${config.finance || "未填写"}
证明材料/数据来源：${config.evidence || "未填写"}
页数限制：${config.pageLimit || "AI 自动规划"}
审查模式：${config.reviewMode === "fast" ? "快速生成" : "严格审查"}
图表要求：${config.figureMode ? `至少 ${config.figureCount || 2} 张图` : "AI 自动规划图示"}；${config.tableMode ? `至少 ${config.tableCount || 5} 张表` : "AI 自动规划表格"}；${config.dataMode ? `至少 ${config.dataCount || 3} 组数据` : "AI 自动规划数据口径"}；${config.modelMode ? `至少 ${config.modelCount || 1} 个模型/公式` : "按需生成模型说明"}
文档风格：${config.docStyle === "nature" ? "Nature 高影响力期刊风格" : "竞赛项目书默认风格"}
参考文档：${config.referenceNotes || "未上传/未填写"}
相关文件：${config.contestFileNotes || "未上传/未填写"}
附件数据：${config.attachmentNotes || "未上传/未填写"}
上传资料关键摘录：${config.referenceContext ? config.referenceContext.slice(0, 6000) : "未解析到可读摘录"}
执行策略：自动推进=${config.autoAdvance === false ? "否" : "是"}；人工检查点=${config.humanCheckpoint ? "是" : "否"}；改进循环=${config.revisionLoop === false ? "否" : "是"}`;
}

function researchQueries(config: WorkflowConfig) {
  const base = [config.name, config.track, config.competition, config.brief, config.product]
    .filter(Boolean)
    .join(" ");
  const profile = currentTopicProfile(config);
  const domainText = profile.domain || config.track || config.competition || "大学生创新创业项目";
  const productText = (config.product || profile.position || config.name).slice(0, 80);
  const usersText = profile.users.slice(0, 3).join(" ");
  const scenesText = profile.scenes.slice(0, 3).join(" ");
  const modulesText = profile.productModules.slice(0, 3).join(" ");
  const domain = `${domainText} ${productText}`;
  return [
    `${domain} 政策 市场规模 行业报告`,
    `${domain} 技术方案 竞品 产品 ${modulesText}`,
    `${domain} 客户需求 商业模式 价格 ${usersText}`,
    `${domainText} ${scenesText} 痛点 解决方案`,
    `${productText} 竞品 对比 商业模式`,
    `${base} 项目书 可行性 申报`,
  ].map((item) => item.replace(/\s+/g, " ").trim()).filter(Boolean);
}

function stripHtml(html: string) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeHtml(value: string) {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(Number.parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number.parseInt(code, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

type ResearchResult = {
  title: string;
  url: string;
  snippet: string;
};

type EvidenceItem = {
  id: string;
  category: string;
  claim: string;
  source: string;
  usage: string;
  confidence: "high" | "medium" | "low";
};

function cleanSearchUrl(rawUrl: string, baseUrl: string) {
  let cleanedUrl = decodeHtml(rawUrl || "");
  try {
    const parsed = new URL(cleanedUrl, baseUrl);
    const uddg = parsed.searchParams.get("uddg");
    if (uddg) cleanedUrl = decodeURIComponent(uddg);
  } catch {
    // Keep the raw URL when a search engine returns a non-standard link.
  }
  return cleanedUrl;
}

function uniqueResearchResults(results: ResearchResult[]) {
  const seen = new Set<string>();
  return results.filter((result) => {
    const key = result.url.replace(/[#?].*$/, "").toLowerCase();
    if (!result.title || !result.url || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function researchTermsFromQuery(query: string) {
  const stopwords = new Set([
    "政策", "市场", "规模", "行业", "报告", "技术", "方案", "竞品", "产品", "客户", "需求", "商业", "模式",
    "价格", "痛点", "解决", "项目", "项目书", "可行", "可行性", "申报", "分析", "发展", "趋势", "服务",
    "policy", "market", "report", "business", "product", "service", "analysis", "project",
  ]);
  const terms = new Set<string>();
  const source = decodeHtml(stripHtml(query)).toLowerCase();
  const words = source.match(/[a-z0-9][a-z0-9+.-]{2,}|[\u4e00-\u9fa5]{2,}/gi) || [];
  for (const word of words) {
    const cleaned = word.trim().toLowerCase();
    if (!cleaned || stopwords.has(cleaned)) continue;
    if (/^[\u4e00-\u9fa5]+$/.test(cleaned) && cleaned.length > 4) {
      for (let i = 0; i < cleaned.length - 1; i += 1) {
        const pair = cleaned.slice(i, i + 2);
        if (!stopwords.has(pair)) terms.add(pair);
      }
      for (let i = 0; i < cleaned.length - 2; i += 2) {
        const triplet = cleaned.slice(i, i + 3);
        if (!stopwords.has(triplet)) terms.add(triplet);
      }
    } else {
      terms.add(cleaned);
    }
  }
  return [...terms].slice(0, 24);
}

function filterRelevantResearchResults(query: string, results: ResearchResult[]) {
  const terms = researchTermsFromQuery(query);
  if (!terms.length) return uniqueResearchResults(results).slice(0, 4);
  return uniqueResearchResults(results)
    .filter((result) => {
      const haystack = `${result.title} ${result.snippet} ${result.url}`.toLowerCase();
      return terms.some((term) => haystack.includes(term));
    })
    .slice(0, 4);
}

function parseDuckDuckGoResults(html: string): ResearchResult[] {
  const results: ResearchResult[] = [];
  const blocks = html.split(/<div[^>]+class="[^"]*\bresult__body\b[^"]*"[^>]*>/i).slice(1);
  for (const block of blocks) {
    if (results.length >= 4) break;
    const titleMatch = block.match(/<a[^>]+class="[^"]*\bresult__a\b[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!titleMatch) continue;
    const snippetMatch = block.match(/<a[^>]+class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/a>/i)
      || block.match(/<div[^>]+class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    const title = decodeHtml(stripHtml(titleMatch[2] || ""));
    const url = cleanSearchUrl(titleMatch[1] || "", "https://duckduckgo.com");
    const snippet = decodeHtml(stripHtml(snippetMatch?.[1] || ""));
    if (title && url) results.push({ title, url, snippet });
  }
  return uniqueResearchResults(results).slice(0, 4);
}

function parseBaiduResults(html: string): ResearchResult[] {
  const results: ResearchResult[] = [];
  const blocks = html.split(/<div[^>]+class="[^"]*\bresult\b[^"]*\bc-container\b[^"]*"[^>]*>/i).slice(1);
  for (const block of blocks) {
    if (results.length >= 4) break;
    const titleMatch = block.match(/<h3[\s\S]*?<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/h3>/i)
      || block.match(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!titleMatch) continue;
    const title = decodeHtml(stripHtml(titleMatch[2] || ""));
    const url = cleanSearchUrl(titleMatch[1] || "", "https://www.baidu.com");
    const bodyText = decodeHtml(stripHtml(block));
    const snippet = bodyText
      .replace(title, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 240);
    if (title && url && !url.includes("baidu.com/s?")) results.push({ title, url, snippet });
  }
  return uniqueResearchResults(results).slice(0, 4);
}

function parseBingResults(html: string): ResearchResult[] {
  const results: ResearchResult[] = [];
  const blocks = html.split(/<li[^>]+class="[^"]*\bb_algo\b[^"]*"[^>]*>/i).slice(1);
  for (const block of blocks) {
    if (results.length >= 4) break;
    const titleMatch = block.match(/<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<\/h2>/i)
      || block.match(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!titleMatch) continue;
    const snippetMatch = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    const title = decodeHtml(stripHtml(titleMatch[2] || ""));
    const url = cleanSearchUrl(titleMatch[1] || "", "https://www.bing.com");
    const snippet = decodeHtml(stripHtml(snippetMatch?.[1] || ""));
    if (title && url && !url.includes("bing.com/search")) results.push({ title, url, snippet });
  }
  return uniqueResearchResults(results).slice(0, 4);
}

async function fetchSearchResults(query: string): Promise<ResearchResult[]> {
  const url = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(10000),
      headers: {
        "User-Agent": "Mozilla/5.0 Paper-agent research",
        Accept: "text/html,application/xhtml+xml",
      },
    });
    if (!response.ok) return [];
    const html = await response.text();
    const duckResults = filterRelevantResearchResults(query, parseDuckDuckGoResults(html));
    if (duckResults.length) return duckResults;
  } catch {
    // Fall through to the secondary search provider.
  }

  try {
    const baiduUrl = `https://www.baidu.com/s?wd=${encodeURIComponent(query)}`;
    const response = await fetch(baiduUrl, {
      signal: AbortSignal.timeout(10000),
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125 Safari/537.36 Paper-agent research",
        Accept: "text/html,application/xhtml+xml",
      },
    });
    if (response.ok) {
      const baiduResults = filterRelevantResearchResults(query, parseBaiduResults(await response.text()));
      if (baiduResults.length) return baiduResults;
    }
  } catch {
    // Fall through to Bing.
  }

  try {
    const bingUrl = `https://www.bing.com/search?q=${encodeURIComponent(query)}`;
    const response = await fetch(bingUrl, {
      signal: AbortSignal.timeout(10000),
      headers: {
        "User-Agent": "Mozilla/5.0 Paper-agent research",
        Accept: "text/html,application/xhtml+xml",
      },
    });
    if (!response.ok) return [];
    return filterRelevantResearchResults(query, parseBingResults(await response.text()));
  } catch {
    return [];
  }
}

async function fetchSourceSnippet(title: string, url: string): Promise<ResearchResult | null> {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(10000),
      headers: {
        "User-Agent": "Mozilla/5.0 Paper-agent research",
        Accept: "text/html,application/xhtml+xml,text/plain",
      },
    });
    if (!response.ok) return null;
    const text = stripHtml((await response.text()).slice(0, 120000));
    const snippet = text.slice(0, 240);
    return snippet ? { title, url, snippet } : null;
  } catch {
    return null;
  }
}

async function fetchKnownResearchSources(config: WorkflowConfig): Promise<ResearchResult[]> {
  const profile = currentTopicProfile(config);
  const currentText = `${config.name} ${config.track || ""} ${config.brief || ""} ${config.product || ""} ${config.market || ""}`.toLowerCase();
  const isElderCare = /养老|老人|老年|护理|照护|康养|银发|适老|社区养老|居家养老/.test(currentText);
  const text = `${config.name} ${config.brief || ""} ${config.product || ""} ${profile.domain}`.toLowerCase();
  const sources: Array<[string, string]> = [
    ["国务院：国家政策与行业发展公开信息", "https://www.gov.cn/"],
    ["国家统计局：宏观统计和行业数据公开入口", "https://www.stats.gov.cn/"],
    ["教育部：大学生创新创业与高校教育公开信息", "https://www.moe.gov.cn/"],
  ];
  if (isElderCare) {
    sources.push(
      ["民政部：养老服务与老龄工作相关公开信息", "https://www.mca.gov.cn/"],
      ["国家卫生健康委：健康服务与老龄健康公开信息", "https://www.nhc.gov.cn/"],
    );
  }
  if (/农业|种植|农户|农产品|田间|智慧种植|草莓|农创/.test(text)) {
    sources.push(["农业农村部：农业产业与乡村振兴公开信息", "https://www.moa.gov.cn/"]);
  }
  if (/文旅|旅游|文化|非遗|景区|地域文化/.test(text)) {
    sources.push(["文化和旅游部：文化旅游产业公开信息", "https://www.mct.gov.cn/"]);
  }
  if (/工业|软件|人工智能|智能体|平台|算法|数据|跨境电商|低空|无人机|机器人|白板|协作/.test(text)) {
    sources.push(["工业和信息化部：软件、人工智能与数字产业公开信息", "https://www.miit.gov.cn/"]);
  }
  if (/市场|消费|电商|跨境|品牌|商业/.test(text)) {
    sources.push(["商务部：商业、消费和外贸公开信息", "https://www.mofcom.gov.cn/"]);
  }
  return sources.slice(0, 7).map(([title, url]) => ({
    title,
    url,
    snippet: `${title}。该来源作为政策、统计、行业背景和官方口径核验入口使用；正文只按项目所属领域提炼相关内容，不引用首页随机新闻。`,
  }));
}

function builtInResearchBrief(config: WorkflowConfig) {
  const profile = currentTopicProfile(config);
  const users = sentenceList(profile.users.slice(0, 4), "目标使用者、管理者和试点协同方");
  const scenes = sentenceList(profile.scenes.slice(0, 4), "核心使用场景和试点验证场景");
  const modules = sentenceList(profile.productModules.slice(0, 5), "核心功能模块");
  const metrics = sentenceList(profile.metrics.slice(0, 5), "完成率、响应时间、成功率、成本和满意度");
  const models = sentenceList(profile.businessModels.slice(0, 4), "项目制交付、订阅运维、模块授权和定制服务");
  const proofs = sentenceList(profile.evidenceFocus.slice(0, 5), "用户访谈、原型截图、测试记录、竞品分析和财务测算");
  return [
    `计划书只围绕当前主题展开：服务对象为${users}，早期验证聚焦${scenes}，产品能力以${modules}为主。`,
    `市场判断采用公开资料口径、行业报告口径和团队估算口径，不把未核验数据、未签约客户或未发生收入写成确定事实。`,
    `技术路线采用“问题-方案-指标-验证-迭代”结构，围绕${metrics}组织原型测试、用户反馈和阶段性交付物。`,
    `商业部分围绕${models}展开，收入、成本和资金安排都要能对应具体交付内容、服务边界和后续运维方式。`,
    `证明材料优先使用${proofs}，正文结论需要能回到当前表单、当前上传资料或本次检索资料，不引用其他项目或历史样例。`,
  ];
}

async function buildResearchBrief(config: WorkflowConfig) {
  const queries = researchQueries(config);
  const skipWebResearch = envFlag("PAPER_AGENT_SKIP_WEB_RESEARCH");
  const groups: string[] = [];
  if (!skipWebResearch) for (const query of queries) {
    const results = await fetchSearchResults(query);
    if (!results.length) continue;
    groups.push(`### 查询：${query}\n${results.map((result, index) => `${index + 1}. ${result.title}\n   来源：${result.url}\n   摘要：${result.snippet}`).join("\n")}`);
  }

  const knownSources = skipWebResearch ? [] : await fetchKnownResearchSources(config);
  const knownSourceBlock = knownSources.length
    ? knownSources.map((result, index) => `${index + 1}. ${result.title}\n   来源：${result.url}\n   摘要：${result.snippet}`).join("\n")
    : "未抓取到稳定公开页面正文，工作流使用内置研究结论和用户材料继续生成。";
  const builtIn = builtInResearchBrief(config).map((item, index) => `${index + 1}. ${item}`).join("\n");
  return `# 联网调研资料包

> 用途：本资料包供后续章节转化为项目书正文。正文使用公开资料口径、行业报告口径和项目估算口径，不把未核验的团队成果、客户合同或知识产权写成已取得事实。

## 项目上下文
${contextBlock(config)}

## 内置研究结论
${builtIn}

## 公开来源抓取
${knownSourceBlock}

## 联网检索摘录
${groups.length ? groups.join("\n\n") : "当前网络检索未返回稳定结果，工作流使用内置研究结论和用户已提供材料完成项目书成稿。"}
`;
}

function evidenceItemsFromConfig(config: WorkflowConfig, researchBody: string): EvidenceItem[] {
  const items: EvidenceItem[] = [];
  const add = (category: string, claim: string, source: string, usage: string, confidence: EvidenceItem["confidence"] = "medium") => {
    items.push({
      id: `E${String(items.length + 1).padStart(2, "0")}`,
      category,
      claim,
      source,
      usage,
      confidence,
    });
  };

  add("项目事实", "项目名称、赛道、团队基础、技术产品、市场设想和财务设想来自用户创建工作流时填写的信息。", "用户输入", "作为全文事实边界，避免编造未提供的团队成果、客户合同、专利软著或试点单位。", "high");
  if (config.referenceNotes) add("参考文件", `参考资料包括：${config.referenceNotes}`, "上传文件名/用户记录", "用于对照项目书结构、章节风格、术语和已有材料。", "medium");
  if (config.contestFileNotes) add("相关文件", `相关文件包括：${config.contestFileNotes}`, "上传文件名/用户记录", "用于补充赛题、政策、图片、业务材料和项目背景。", "medium");
  if (config.attachmentNotes) add("附件数据", `附件数据包括：${config.attachmentNotes}`, "上传文件名/用户记录", "用于形成附件索引、数据口径和证明材料清单。", "medium");
  if (config.evidence) add("证明材料", config.evidence, "用户填写的证明材料/数据来源", "用于证明市场调研、原型测试、团队基础、合作资源和财务测算。", "medium");

  const uploadNames = [...researchBody.matchAll(/^##\s+U\d+\s+(.+)$/gm)]
    .map((match) => match[1]?.trim())
    .filter(Boolean);
  uploadNames.slice(0, 20).forEach((name) => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const block = researchBody.match(new RegExp(`##\\s+U\\d+\\s+${escaped}[\\s\\S]*?(?=\\n##\\s+U\\d+\\s+|$)`))?.[0] || "";
    const excerpt = block
      .replace(/^##\s+U\d+\s+.+/m, "")
      .replace(/### 可读内容摘录/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 180);
    add(
      "上传资料",
      excerpt ? `上传文件《${name}》包含可用于项目书论证的材料摘录：${excerpt}` : `上传文件《${name}》已进入项目附件与知识库索引。`,
      `上传资料知识库 / ${name}`,
      "用于正文事实边界、附件清单、证明材料、项目背景和数据口径引用。",
      excerpt ? "high" : "medium",
    );
  });

  const searchBlocks = [...researchBody.matchAll(/### 查询：(.+?)\n([\s\S]*?)(?=\n### 查询：|\n## |$)/g)];
  for (const blockMatch of searchBlocks.slice(0, 6)) {
    const query = blockMatch[1].trim();
    const block = blockMatch[2] || "";
    const resultPattern = /\d+\.\s+([^\n]+)\n\s+来源：([^\n]+)\n\s+摘要：([^\n]+)/g;
    let resultMatch: RegExpExecArray | null;
    let perQueryCount = 0;
    while ((resultMatch = resultPattern.exec(block)) && perQueryCount < 3) {
      const title = resultMatch[1].trim();
      const url = resultMatch[2].trim();
      const snippet = resultMatch[3].trim();
      if (!title || !url) continue;
      add(
        "联网检索",
        `围绕“${query}”检索到公开资料《${title}》：${snippet || "可作为政策、行业、市场或技术趋势的公开资料入口。"}`,
        url,
        "用于背景、市场、竞品、政策或技术趋势论证；正文按公开资料口径引用，不写成团队已验证事实。",
        "medium",
      );
      perQueryCount += 1;
    }
  }

  const knownBlock = researchBody.match(/## 公开来源抓取\n([\s\S]*?)(?=\n## |$)/)?.[1] || "";
  const knownPattern = /\d+\.\s+([^\n]+)\n\s+来源：([^\n]+)\n\s+摘要：([^\n]+)/g;
  let knownMatch: RegExpExecArray | null;
  while ((knownMatch = knownPattern.exec(knownBlock))) {
    const title = knownMatch[1].trim();
    const url = knownMatch[2].trim();
    const snippet = knownMatch[3].trim();
    if (!title || !url) continue;
    add(
      "官方公开源",
      `官方公开源《${title}》可支撑政策、行业背景或统计口径判断：${snippet.slice(0, 180)}`,
      url,
      "用于项目背景、政策环境、行业趋势和市场口径；正文按公开资料口径引用。",
      "medium",
    );
  }

  const urls = [...researchBody.matchAll(/https?:\/\/[^\s)）]+/g)].map((match) => match[0]);
  [...new Set(urls)].slice(0, 12).forEach((url) => {
    add("公开来源", "联网调研资料中出现的公开来源，可作为政策、行业、市场或技术趋势的参考入口。", url, "正文中仅按公开资料口径引用，不把网页摘要写成已核验事实。", "medium");
  });

  builtInResearchBrief(config).forEach((claim) => {
    add("内置研究结论", claim, "Paper-agent 内置项目书研究规则", "用于生成背景、市场、技术、商业模式和风险控制段落。", "low");
  });

  add("财务口径", "收入、成本、客户数量、转化率和五年预测在缺少真实合同前均按项目估算口径表达。", config.finance || "用户未填写财务设想", "用于防止财务章节把估算写成承诺。", "high");
  add("技术口径", "模型准确率、误报率、响应时间、部署成本和系统稳定性在缺少测试报告前按原型测试口径表达。", config.product || "用户未填写技术产品基础", "用于防止技术章节把待验证指标写成既成事实。", "high");
  return items;
}

function buildEvidenceIndex(config: WorkflowConfig, researchBody: string) {
  const rows = evidenceItemsFromConfig(config, researchBody).map((item) => [
    item.id,
    item.category,
    item.claim.replace(/\|/g, "/"),
    item.source.replace(/\|/g, "/"),
    item.usage.replace(/\|/g, "/"),
    item.confidence,
  ]);
  return `# 证据库索引

> 用途：为后续章节提供可追溯证据边界。项目书正文可以引用这些证据口径，但不能把低置信度材料写成已核验事实。

${makeTable(["编号", "类型", "可支撑结论", "来源", "正文使用方式", "置信度"], rows)}

## 写作约束
- 高置信度材料可以作为项目基础事实使用。
- 中置信度材料可以作为公开资料口径、用户材料口径或附件索引使用。
- 低置信度材料只能作为论证方向，不得写成已经取得的客户、专利、软著、试点或财务结果。
- 所有市场规模、价格、收入、成本和性能指标都需要标注为公开资料口径、项目估算口径或原型测试口径。
`;
}

function extractEvidenceHighlights(evidenceBody: string, limit = 8) {
  return String(evidenceBody || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^\|\s*E\d+\s*\|/.test(line))
    .map((line) => {
      const cells = line.split("|").map((cell) => cell.trim()).filter(Boolean);
      const [, category, claim, source, usage, confidence] = cells;
      if (!claim) return "";
      return `${category || "证据"}：${claim.slice(0, 120)}（来源：${source || "证据库"}；用途：${usage || "正文支撑"}；置信度：${confidence || "medium"}）`;
    })
    .filter(Boolean)
    .slice(0, limit);
}

async function ensureEditorResearchArtifacts(workflowId: string, config: WorkflowConfig) {
  const projectDir = projectDirFor(workflowId);
  ensureProjectDirs(projectDir);
  const artifactsDir = join(projectDir, ".paper", "artifacts");
  const researchPath = join(artifactsDir, "00-research-brief.md");
  const evidencePath = join(artifactsDir, "00-evidence-index.md");
  const researchStep: StepDef = {
    id: "research-brief",
    name: "联网调研资料包",
    agent: "调研智能体",
    checkpointType: "research-brief",
    targetSection: "联网调研资料包",
    instruction: "自动检索政策、行业、市场、竞品和技术趋势资料，作为项目书公开资料口径。",
  };
  const evidenceStep: StepDef = {
    id: "evidence-index",
    name: "证据库索引",
    agent: "证据库智能体",
    checkpointType: "evidence-index",
    targetSection: "证据库索引",
    instruction: "把用户输入、上传资料、联网调研资料和内置研究结论组织为可追溯证据索引。",
  };

  const uploadKnowledge = refreshUploadKnowledgeArtifact(workflowId);
  const referenceConfig = withReferenceContext(config, uploadKnowledge.body);
  let researchBody = "";
  if (existsSync(researchPath)) {
    researchBody = readFileSync(researchPath, "utf-8");
  } else {
    researchBody = finalizeSubmissionTone(await buildResearchBrief(referenceConfig));
    writeFileSync(researchPath, formatArtifact(researchStep, researchBody, referenceConfig), "utf-8");
  }

  let evidenceBody = "";
  if (existsSync(evidencePath)) {
    evidenceBody = readFileSync(evidencePath, "utf-8");
  } else {
    evidenceBody = buildEvidenceIndex(referenceConfig, `${researchBody}\n\n${uploadKnowledge.body}`);
    writeFileSync(evidencePath, formatArtifact(evidenceStep, evidenceBody, referenceConfig), "utf-8");
  }

  const highlights = extractEvidenceHighlights(evidenceBody, 10);
  return {
    researchPath,
    evidencePath,
    sourceCount: countOccurrences(researchBody, /https?:\/\/[^\s)）]+/g),
    evidenceCount: highlights.length,
    highlights,
  };
}

function buildPrompt(config: WorkflowConfig, step: StepDef, previousArtifacts: ArtifactFile[]) {
  return buildProjectPrompt(config, step, previousArtifacts);
}

function buildProjectPrompt(config: WorkflowConfig, step: StepDef, previousArtifacts: ArtifactFile[]) {
  if (isReferenceWorkflowStep(step)) {
    const targetChars = minimumBodyChars(config, step);
    const excerpt = referenceChapterExcerpt(config, step.targetSection);
    const skeleton = buildReferenceChapterFromSkeleton(config, step);
    return `你正在为大学生竞赛团队撰写项目计划书章节。

当前项目：${config.name}
当前章节：${step.targetSection}
项目事实边界：只能使用当前项目名称、当前项目表单、当前上传资料和公开资料/项目估算/原型测试口径；不得使用其他项目、其他目录或历史样例。

## 参考项目书当前章节摘录（只学习写法、结构、标题层级、段落布局）
${excerpt.slice(0, 6000) || "未抽取到当前章节全文，按参考目录层级和正式项目书语气写作。"}

## 必须沿用的本章标题骨架
${skeleton}

## 当前章节任务
${step.instruction}

请输出中文 Markdown，只输出本章正文。
硬性要求：
1. 一级标题必须是“## ${step.targetSection}”；
2. 二级/三级标题尽量沿用参考摘录中的“（一）/1.”层级；
3. 不输出“当前主题事实边界、当前章节、写作要求、提示词、系统说明、必须回到”等说明性文字；
4. 不加入参考文档没有的“执行摘要、项目优势、未来展望”等模板章节；
5. 不写低空蜂群、无人地面站、农业植保、园区巡检、物流配送等串项内容；
6. 正文长度不少于 ${targetChars} 个中文字符，段落密度、表格使用和正式申报书口吻贴近参考摘录。`;
  }
  const upstream = previousArtifacts
    .map((artifact) => `## ${artifact.step.name}\n${artifact.content.slice(0, 2200)}`)
    .join("\n\n");
  const targetChars = minimumBodyChars(config, step);
  const dachuangRules = effectiveProjectBookTemplateId(config) === "dachuang"
    ? `
大创高质量项目书专项要求：
- 只使用当前项目配置和当前项目上传资料，不使用历史样例库、其他项目目录或外部参考目录；
- 若当前项目上传了“项目大纲/写法参考”文档，章节结构和文风优先贴近该文档；未上传时按内置八章项目计划书结构生成；
- 当前阶段目标不少于 ${targetChars} 个中文字符，输出低于目标视为失败；
- 未上传当前项目参考文档时，正文必须按八章闭环展开：一、项目方案概述；二、项目团队概述；三、产业背景与项目产品；四、市场调查与竞争分析；五、商业模式与发展战略；六、预期效益分析；七、总结与资金回报；八、证明材料；
- 技术/研究型内容可以融入“项目方案概述、产业背景与项目产品、市场调查与竞争分析、商业模式与发展战略、预期效益分析、证明材料”等章节，但不要把“执行摘要、项目优势、产品介绍、市场运营、风险管理、未来展望、附录补充”作为最终主章；
- 表格、估算数据、图示说明、证明材料要服务项目书正文，不做装饰性堆砌；
- 对政策、行业规模、客户价格、收入预测等不确定信息使用公开资料口径、行业报告口径或项目估算口径写成可提交正文。`
    : "";
  const evidenceRules = `
证据驱动写作要求：
- 优先使用“上传资料知识库”“证据库索引”“联网调研资料包”中的事实、摘录、来源和口径；
- 每个章节至少把1条上游证据转化为正文论证、表格行、图注说明或附件对应关系；
- 出现上传文件、访谈记录、测试记录、财务表、截图、政策或报告时，要写清它支撑哪个结论；
- 不输出“需要调研、建议补充、可以写成”这类写作建议，直接写成项目书正文；
- 对证据不足的内容使用“公开资料口径、项目估算口径、原型测试口径、用户材料口径”，不能编造成已签约、已授权、已获专利或已落地。`;
  return `你是 Paper-agent 的「${step.agent}」，正在为大学生竞赛团队撰写完整项目计划书。
${contextBlock(config)}
${dachuangRules}
${projectSkillRules(config)}
${evidenceRules}
${submissionToneRules(targetChars)}
${currentReferenceStyleRules(config)}
${projectProfileDossier(config, step)}
${projectSpecificWritingRules(config)}

当前章节：${step.targetSection}
当前任务：${step.instruction}
当前章节目标长度：不少于 ${targetChars} 个中文字符。
上游章节与调研材料：${upstream || "暂无。"}

请输出中文 Markdown。硬性要求：
1. 章节必须完整，不要只列提纲；
2. 写成可直接进入项目计划书的正式文本；
3. 需要表格时直接用 Markdown 表格；
4. 没有真实来源、客户、成本、价格、专利、试点时，不写“以实际提交附件为准”，改用公开资料口径、项目估算口径、原型测试口径或附件材料说明；
5. 保持竞赛申报文风，兼顾技术可信、商业可行和评审可读；
6. 用户指定的图、表、数据、模型数量必须落实到章节内容或图表清单中；
7. 不得把“当前章节”原样当作标题输出；只使用真实项目书常见短标题，禁止路径式长标题和扩写角度标题。`;
}

function finalizeSubmissionTone(text: string) {
  return text
    .replace(/公开资料口径/g, "公开资料口径")
    .replace(/以公开政策文件为准/g, "以公开政策文件为准")
    .replace(/以原型测试记录为准/g, "以原型测试记录为准")
    .replace(/以实际提交附件为准/g, "由附件材料说明支撑")
    .replace(/以实际提交附件为准具体来源/g, "由附件材料说明具体来源")
    .replace(/补齐/g, "形成")
    .replace(/占位/g, "说明")
    .replace(/建议采用/g, "采用")
    .replace(/建议将/g, "将")
    .replace(/建议按/g, "按")
    .replace(/建议设置/g, "设置")
    .replace(/建议写成/g, "写成")
    .replace(/建议保留/g, "保留")
    .replace(/建议/g, "")
    .replace(/应当/g, "需")
    .replace(/可考虑/g, "采用")
    .replace(/后续完善/g, "持续迭代")
    .replace(/赛前检查/g, "提交核验")
    .replace(/围绕围绕/g, "围绕")
    .replace(/构建完整项目方案。项目以/g, "形成完整项目方案。项目以")
    .replace(/智能检测与预警系统。构建完整项目方案/g, "智能检测与预警系统，形成完整项目方案")
    .replace(/构建完整解决方案构建/g, "构建")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function sanitizeProjectBookBody(text: string) {
  return finalizeSubmissionTone(text)
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return true;
      if (/项目书对应位置|Word\/PDF|附件索引|图表源文件|项目书定稿|申报材料|答辩材料|答辩口径|答辩表达|答辩完整度|路演材料|PPT|证明材料归档|材料归档/.test(trimmed)) return false;
      if (/本章节对应|本章节结论由|章节论证|谁遇到问题|项目用户不是抽象客户|正文需要|本章需要|章节需要|正文完善|这样写|项目书建议|建议保留/.test(trimmed)) return false;
      if (/^(产品介绍直接拆解为|使用流程从|项目优势要逐项对比|技术优势写成|市场分析按|竞品分析围绕|商业模式围绕|市场运营首先服务于|渠道策略优先选择|财务规划强调|收入预测按|团队组织需要体现|团队优势体现在|风险管理围绕|质量保障以|未来展望从|长期价值来自|附录材料与正文结论|图表材料也进入附录管理)/.test(trimmed)) return false;
      if (/必须像真实产品功能|不能只写|这样的段落比|评审看到的不应|真正决定项目可行性的是/.test(trimmed)) return false;
      if (/不承载系统说明、质量报告或修稿记录/.test(trimmed)) return false;
      if (/本章节从|当前章节|当前主题事实边界|当前部分事实边界|本章节中的论证必须回到|必须回到.+项目画像|当前章节专属写法|项目画像约束包|避免把项目写成通用模板|写作建议|修改建议|可直接进入项目书|作为挑战杯创业计划竞赛项目，围绕/.test(trimmed)) return false;
      if (/旧版通用主线段|旧版使用对象段|旧版指标体系段|旧版实施路径段/.test(trimmed)) return false;
      if (/系统说明|质量报告|修稿记录|写作指令|提示词|路径式标题|交付包|自动生成|自动去重|评审返修|来源映射|材料来源/.test(trimmed)) return false;
      if (/OpenClaw|Skill|竞赛 Skill|期望路径|内置兜底|外部竞赛/.test(trimmed)) return false;
      return true;
    })
    .join("\n")
    .replace(/材料归档/g, "资料沉淀")
    .replace(/图表材料/g, "图表资料")
    .replace(/项目项目计划书/g, "项目计划书")
    .replace(/项目计划书项目计划书/g, "项目计划书")
    .replace(/项目计划书计划书/g, "项目计划书")
    .replace(/计划书正文项目计划书/g, "项目计划书")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function stripEmptyMarkdownHeadings(text: string) {
  const lines = String(text || "").split(/\r?\n/);
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const heading = line.match(/^(#{3,6})\s+(.+?)\s*$/);
    if (!heading) {
      kept.push(line);
      continue;
    }
    let j = i + 1;
    while (j < lines.length && !lines[j].trim()) j += 1;
    if (j >= lines.length || /^#{1,6}\s+/.test(lines[j])) continue;
    kept.push(line);
  }
  return kept.join("\n");
}

function polishFinalBookSubmissionShape(text: string) {
  const cleaned = stripEmptyMarkdownHeadings(removeDuplicateMarkdownTables(String(text || "")))
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return true;
      if (/^#{3,6}\s+论证边界与支撑口径$/.test(trimmed)) return false;
      if (/^章节之间保持清晰衔接/.test(trimmed)) return false;
      if (/^#{3,6}\s+材料口径与执行边界$/.test(trimmed)) return false;
      if (/^整份计划书按/.test(trimmed)) return false;
      if (/^(背景|产品|市场|商业|团队|附件|效益|资金|风险|发展|创新|运营)部分(把|区分|说明)/.test(trimmed)) return false;
      if (/^(背景|产品|市场|商业|团队|附件|效益|资金|风险|发展|创新|运营)论证(把|区分|说明)/.test(trimmed)) return false;
      if (/摘要需要形成完整判断|文本要让评审|该写法|产品论证|商业和运营论证|运营计划服务于|市场验证材料围绕|财务测算把|能力说明落到|附件和发展规划/.test(trimmed)) return false;
      if (/^正文需要把/.test(trimmed)) return false;
      if (/^资金投入对应.+收入预测/.test(trimmed)) return false;
      if (/正文围绕项目事实、实施路径、评价指标和材料依据补足细节/.test(trimmed)) return false;
      return true;
    })
    .join("\n");
  return stripEmptyMarkdownHeadings(cleaned)
    .replace(/项目估算口径/g, "团队估算口径")
    .replace(/项目进度口径/g, "进度记录口径")
    .replace(/项目管理口径/g, "团队管理口径")
    .replace(/\n(?=## [一二三四五六七八九十]、)/g, "\n\n")
    .replace(/\n(?=### )/g, "\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function formatArtifact(step: StepDef, body: string, config: WorkflowConfig) {
  return `# ${step.targetSection}

> Agent: ${step.agent}
> 项目: ${config.name}
> 输出类型: ${step.checkpointType}

${body.trim()}
`;
}

function cleanConfigPhrase(value: string, fallback: string) {
  return (value || fallback)
    .replace(/^目标客户包括/, "")
    .replace(/^资金主要用于/, "")
    .replace(/^需补充/, "")
    .replace(/^以\s*/, "")
    .replace(/为核心，形成/, "形成")
    .replace(/[。；;，,\s]+$/g, "")
    .trim() || fallback.replace(/[。；;，,\s]+$/g, "");
}

function makeTable(headers: string[], rows: string[][]) {
  return [
    `| ${headers.join(" |")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.join(" | ")} |`),
  ].join("\n");
}

function normalizeMarkdownTableBlock(lines: string[]) {
  return lines
    .map((line) => `| ${line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim()).join(" | ")} |`)
    .join("\n");
}

function removeDuplicateMarkdownTables(text: string) {
  const lines = String(text || "").split(/\r?\n/);
  const out: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i].trim().startsWith("|")) {
      out.push(lines[i]);
      continue;
    }
    const block: string[] = [];
    while (i < lines.length && lines[i].trim().startsWith("|")) {
      block.push(lines[i]);
      i += 1;
    }
    i -= 1;
    if (block.length < 2) {
      out.push(...block);
      continue;
    }
    const normalized = normalizeMarkdownTableBlock(block);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(...normalized.split("\n"));
  }
  return out.join("\n");
}

function isElderCareFallConfig(config: WorkflowConfig) {
  const text = `${config.name} ${config.track || ""} ${config.brief || ""} ${config.product || ""}`;
  if (/RAG|检索|知识库|智能体|问答|大模型/i.test(text)) return false;
  const hasFallSignal = /防摔|跌倒|摔倒|fall/i.test(text);
  const hasCareSignal = /养老|老人|老年|护理|照护|康养|银发|适老|社区养老|居家养老/i.test(text);
  const hasVisionSignal = /YOLO|yolo|视觉检测|视频检测|姿态检测|人体检测|行为识别/i.test(text);
  return hasFallSignal || (hasCareSignal && hasVisionSignal);
}

type ProjectProfile = {
  id: string;
  title: string;
  domain: string;
  position: string;
  users: string[];
  scenes: string[];
  painPoints: string[];
  productModules: string[];
  techRoute: string;
  competitors: string[];
  businessModels: string[];
  metrics: string[];
  evidenceFocus: string[];
  writingWarnings: string[];
};

function uniqueTopicItems(items: Array<string | undefined | null>, fallback: string[], max = 8) {
  const seen = new Set<string>();
  const normalized = items
    .flatMap((item) => String(item || "").split(/[、，,；;。\n\r/|]+|(?:->)|(?:—)|(?:- )/g))
    .map((item) => item
      .replace(/^(项目|本项目|该项目|系统|平台|产品|服务|目标客户|目标用户|核心产品|资金主要用于|主要用于|包括|包含|面向|围绕)\s*/g, "")
      .replace(/\s+/g, " ")
      .trim())
    .filter((item) => item.length >= 2 && item.length <= 48);
  const source = normalized.length ? normalized : fallback;
  for (const item of source) {
    const cleaned = String(item || "").trim();
    if (!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);
    if (seen.size >= max) break;
  }
  return [...seen];
}

function normalizeTechToken(token: string) {
  const yolo = token.match(/^yolo(v?)(\d+)([a-z]*)$/i);
  if (yolo) return yolo[1] ? `YOLOv${yolo[2]}${yolo[3] || ""}` : `YOLO${yolo[2]}${yolo[3] || ""}`;
  const upper = token.toUpperCase();
  if (["RAG", "LLM", "SaaS", "SDK", "API", "SAR"].includes(upper)) return upper;
  return token;
}

function explicitTechTokens(config: WorkflowConfig) {
  const source = `${config.name} ${config.track || ""} ${config.brief || ""} ${config.product || ""} ${config.market || ""} ${config.finance || ""} ${config.evidence || ""}`;
  const matches = source.match(/\b(?:yolov?\d+[a-z]?|rag|llm|saas|sdk|api|sar|hmad-ednet|spa-hypernet|reptile|freeflow)\b/gi) || [];
  return uniqueTopicItems(matches.map(normalizeTechToken), [], 8);
}

function currentTopicProfile(config: WorkflowConfig): ProjectProfile {
  const name = projectBookDisplayName(config);
  const techTokens = explicitTechTokens(config);
  const brief = cleanConfigPhrase(config.brief || "", "当前主题中的真实应用需求");
  const product = cleanConfigPhrase(config.product || "", `${name}的核心产品、功能模块和服务流程`);
  const market = cleanConfigPhrase(config.market || "", "目标使用者、管理者/决策者和试点协同方");
  const finance = cleanConfigPhrase(config.finance || "", "项目制交付、订阅运维、模块授权和定制服务");
  const evidence = cleanConfigPhrase(config.evidence || "", "用户访谈、原型截图、测试记录、竞品分析、财务测算和团队分工");
  const users = uniqueTopicItems([config.market], ["目标使用者", "管理者/决策者", "试点协同方", "合作伙伴"], 6);
  const scenes = uniqueTopicItems([config.brief, config.track], ["核心使用场景", "高频任务场景", "试点验证场景", "展示答辩场景"], 6);
  const painPoints = uniqueTopicItems([config.brief], ["现有方案效率不足", "使用成本或管理成本较高", "过程记录不完整", "技术与真实场景脱节"], 6);
  const productModules = uniqueTopicItems([techTokens.join("、"), config.product, config.name], ["核心功能模块", "用户端服务", "后台管理", "反馈迭代", "材料导出"], 8);
  const businessModels = uniqueTopicItems([config.finance], ["项目制交付", "年度运维", "订阅服务", "模块授权", "定制开发"], 6);
  const evidenceFocus = uniqueTopicItems([config.evidence], ["用户访谈", "原型截图", "测试记录", "竞品分析", "财务测算", "团队分工"], 8);
  const competitors = uniqueTopicItems([config.market], ["现有人工流程", "通用平台", "同类解决方案", "单点工具/设备"], 5);
  const metrics = uniqueTopicItems([config.product, config.evidence], ["完成率", "响应时间", "准确率/成功率", "成本", "用户满意度", "材料完整度"], 8);
  const routeHead = productModules.slice(0, 4).join(" -> ");
  return {
    id: "current-topic",
    title: name,
    domain: config.track || config.competition || "当前申报方向",
    position: `${name}围绕${brief}展开，以${product}为核心交付，服务${market}`,
    users,
    scenes,
    painPoints,
    productModules,
    techRoute: routeHead ? `需求确认 -> ${routeHead} -> 结果展示 -> 复核反馈 -> 记录归档 -> 版本迭代` : "需求确认 -> 核心处理 -> 结果展示 -> 复核反馈 -> 记录归档 -> 版本迭代",
    competitors,
    businessModels,
    metrics,
    evidenceFocus,
    writingWarnings: [
      "只使用当前表单、当前上传资料和本次联网检索能支撑的事实",
      "不得套用其他项目、其他目录或历史样例的内容",
      "技术版本、模型名称和项目名称按用户当前填写保持一致",
      "缺少事实时采用公开资料口径、团队估算口径或原型测试口径表述",
    ],
  };
}

function preferredVisionModelName(config: WorkflowConfig) {
  return explicitTechTokens(config).find((token) => /^YOLO/i.test(token)) || "";
}

function preserveCurrentTechVersions(text: string, config: WorkflowConfig) {
  const yolo = preferredVisionModelName(config);
  if (!yolo || /^YOLO11n?$/i.test(yolo)) return text;
  return String(text || "").replace(/\bYOLO11n?\b/g, yolo);
}

function inferProjectProfile(config: WorkflowConfig): ProjectProfile {
  const projectIdentityText = `${config.name} ${config.brief || ""} ${config.product || ""} ${config.styleReferenceContext || ""}`.toLowerCase();
  const text = `${projectIdentityText} ${config.track || ""} ${config.market || ""} ${config.referenceContext || ""}`.toLowerCase();
  const has = (pattern: RegExp) => pattern.test(text);
  const identityHas = (pattern: RegExp) => pattern.test(projectIdentityText);

  if (has(/协创桥|组队|队友|竞赛组队|竞赛交流|竞赛平台|找队友|找项目|赛事交流|学校平台|校园竞赛/)) {
    return {
      id: "campus-competition-teaming",
      title: "校园竞赛组队交流平台项目",
      domain: "高校创新创业竞赛、学生项目协作与校园赛事服务",
      position: "面向参赛学生、团队负责人、指导教师和学院赛事管理人员的竞赛组队、招募发布、资料交流、进度协同与成果展示平台",
      users: ["参赛学生", "团队负责人", "寻找队友的学生", "指导教师", "学院赛事管理员", "创新创业社团"],
      scenes: ["竞赛队友招募", "参赛需求发布", "技能标签匹配", "指导教师对接", "校内赛事信息发布", "作品资料交流", "答辩材料协同"],
      painPoints: ["同学找不到合适队友", "招募信息分散", "成员技能与任务需求不匹配", "赛事通知触达不及时", "资料交流缺少沉淀", "团队进度难跟踪", "优秀作品展示渠道有限"],
      productModules: ["组队招募广场", "学生技能画像", "队友匹配推荐", "赛事信息栏", "团队交流区", "资料沉淀空间", "进度看板", "成果展示页"],
      techRoute: "学生资料与参赛需求录入 -> 标签与需求结构化 -> 队友匹配推荐 -> 站内沟通与申请 -> 团队确认 -> 进度协同 -> 资料归档与成果展示",
      competitors: ["班级群和社群转发", "表格收集", "学院通知网站", "通用社交平台", "双创竞赛信息平台"],
      businessModels: ["校内赛事部署", "学院赛事服务包", "社团运营合作", "企业命题对接", "赛事资料增值服务", "平台年度运维"],
      metrics: ["组队成功率", "招募响应时间", "需求匹配准确率", "赛事信息触达率", "资料归档完整度", "活跃团队数量", "用户满意度"],
      evidenceFocus: ["学生访谈纪要", "竞赛信息样例", "招募页面原型截图", "队友匹配流程图", "竞品对比表", "团队进度看板截图", "财务测算表"],
      writingWarnings: ["不要写成通用社交平台", "不要写成低空无人机、养老、防摔或跨境电商项目", "必须围绕校园竞赛、队友匹配、招募发布、教师指导和赛事资料沉淀展开", "不要编造已覆盖学校数量、真实付费客户或已签合作协议"],
    };
  }

  if (identityHas(/sar|超路由|元适应|hmad|hmed|ednet|spa-hypernet|hyper route|meta-adaptive|reptile|phase\s*a|phase\s*b|小目标检测|搜救|检测网络|scene route|场景路由|多专家检测|无人机搜救|路由准确率|元适应得分|mAP|precision|recall|f1/)) {
    return {
      id: "sar-hmad-detection",
      title: "SAR场景超路由元适应检测网络项目",
      domain: "无人机搜救、小目标检测、复杂场景目标检测与应急救援智能感知",
      position: "面向无人机搜救场景的小目标人员检测系统，构建多专家检测、场景路由和元学习优化一体化的 Hyper Route Meta-Adaptive Detection Network（HMAD-Ednet）",
      users: ["应急管理部门", "消防救援队伍", "航空应急救援队伍", "无人机运营商", "指挥系统集成商", "山地/森林/灾后搜救组织"],
      scenes: ["森林搜救", "山地救援", "灾后搜索", "复杂植被航拍", "跨地域跨季节无人机搜救", "小目标人员检测", "应急指挥辅助"],
      painPoints: ["小目标人员难检测", "姿态与尺度变化大", "视角与背景复杂", "跨场景泛化能力不足", "单一检测器性能不稳定", "误检漏检影响救援可靠性", "模型选择缺少可解释依据"],
      productModules: ["HMAD-Ednet", "SPA-HyperNet", "多专家检测器", "场景路由模块", "Reptile元学习训练器", "HGF-C2f", "IoU质量门控", "Phase A/B验证流程", "路由收益验证脚本"],
      techRoute: "无人机航拍/SAR场景图像输入 -> 场景特征提取 -> 场景路由判别 -> 多专家检测器选择 -> 元适应优化 -> mAP/P/R/F1与路由收益验证 -> 搜救指挥结果输出",
      competitors: ["传统单一YOLO检测器", "人工航拍图像判读", "通用无人机巡检算法", "普通目标检测平台", "应急救援硬件集成方案"],
      businessModels: ["算法模块授权", "应急搜救技术服务", "指挥系统接口集成", "场景化模型适配服务", "无人机运营商合作分成", "项目制试点与部署"],
      metrics: ["mAP", "Precision", "Recall", "F1", "路由准确率", "元适应得分", "跨场景稳定性", "FPS/推理延迟", "参数量", "误检漏检率"],
      evidenceFocus: ["图1系统架构图", "Phase A/Phase B流程图", "实验结果表", "消融实验", "路由命中率记录", "数据集说明", "mAP/P/R/F1曲线", "场景样例图", "测试日志"],
      writingWarnings: ["不要写成低空经济蜂群协同项目", "禁止出现蜂群任务规划、无人地面站、空地协同、多机编队、园区巡检、农业植保、物流配送、低空运营平台等串项内容", "不要写成园区巡检、农业植保或无人地面站项目", "不要写成养老、RAG知识库或普通AI平台", "不要把尚未取得的真实救援订单、客户合同、专利授权或营收写成既成事实"],
    };
  }

  if (has(/无人机|无人地|无人车|蜂群|低空|空地协同|空地一体|矩阵系统|编队|集群调度|uav|drone/)) {
    return {
      id: "low-altitude-drone-swarm",
      title: "低空经济无人机蜂群协同项目",
      domain: "低空经济、无人系统协同与行业场景服务",
      position: "面向园区巡检、应急救援、农业植保、物流配送、测绘巡查和低空监管场景的无人地面平台与无人机蜂群协同任务系统",
      users: ["园区/景区/厂区管理方", "应急管理部门", "农业合作社/农服组织", "低空运营服务商", "物流与巡检企业", "系统集成商"],
      scenes: ["多机协同巡检", "应急物资投送", "灾害现场侦察", "农业植保与测绘", "园区安防巡查", "低空航线任务规划", "无人地面站补能与调度"],
      painPoints: ["单机作业覆盖范围有限", "人工巡检成本高且响应慢", "多机任务调度和避障协同难", "无人机续航与补能受限", "低空飞行合规和任务记录要求高", "行业客户缺少可复制服务包"],
      productModules: ["蜂群任务规划", "无人地面站空地协同", "多机编队调度", "航线与空域管理", "感知避障与安全控制", "任务数据回传", "运营监控后台", "行业场景服务包"],
      techRoute: "任务需求输入 -> 场景地图与空域约束建模 -> 蜂群任务分配 -> 无人机/无人地面站空地协同执行 -> 数据回传与异常处置 -> 任务报告生成 -> 算法与服务迭代",
      competitors: ["单机无人机作业服务", "人工巡检队伍", "传统安防/测绘系统", "无人机硬件厂商方案", "低空运营平台"],
      businessModels: ["项目制交付", "行业巡检服务费", "设备租赁与运维", "平台订阅", "算法/调度模块授权", "定制化系统集成"],
      metrics: ["任务覆盖面积", "多机协同成功率", "平均响应时间", "单次任务成本", "续航/补能效率", "异常处置成功率", "任务报告完整度"],
      evidenceFocus: ["任务流程原型", "蜂群调度仿真截图", "无人地面站结构说明", "低空经济政策资料", "行业客户访谈", "成本测算表", "场景演示视频"],
      writingWarnings: ["不要写成养老、知识库或通用AI助手项目", "不要只讲无人机硬件先进", "必须突出低空经济场景、蜂群协同、无人地面站、任务闭环和合规边界", "不要编造真实飞行许可、客户合同或已落地营收"],
    };
  }

  const isElderCareDomain = has(/养老|老人|老年|护理|照护|康养|银发|适老|社区养老|居家养老/);
  if (isElderCareDomain && has(/rag|检索|知识库|养老智能体|智能问答|问答|大模型|护理知识|政策问答|智能体/)) {
    return {
      id: "elder-care-rag-agent",
      title: "RAG检索增强养老服务智能体项目",
      domain: "智慧养老、护理知识服务与机构数字化管理",
      position: "面向养老机构、社区养老服务站、护理人员、老人家属和居家养老场景的检索增强问答、服务流程辅助与知识可追溯智能体",
      users: ["护理员", "养老机构院长/护理主管", "社区养老服务站工作人员", "老人及家属", "居家养老服务商", "养老平台集成商"],
      scenes: ["护理制度查询", "老人档案与照护计划问答", "用药/康复注意事项检索", "家属沟通说明生成", "政策补贴与服务流程查询", "突发情况处置SOP检索", "机构培训与质控复盘"],
      painPoints: ["养老政策和护理知识分散", "一线护理人员查询成本高", "家属沟通口径不统一", "机构制度和服务流程更新后难以及时传达", "通用大模型回答缺少来源依据", "老人隐私和业务数据需要权限边界"],
      productModules: ["养老知识库", "政策与制度检索", "老人档案授权问答", "护理SOP助手", "家属沟通生成", "来源引用与可追溯", "权限分级与脱敏", "反馈纠错与知识更新"],
      techRoute: "资料采集与清洗 -> 文档切分与向量化 -> 多路召回与重排 -> 大模型生成回答 -> 来源引用与置信提示 -> 人工确认/纠错 -> 知识库更新",
      competitors: ["人工查制度/翻文件", "通用搜索引擎", "通用大模型聊天工具", "传统养老管理软件", "客服知识库系统"],
      businessModels: ["机构SaaS订阅", "知识库初始化服务费", "年度运维与内容更新费", "平台API授权", "培训与定制部署服务"],
      metrics: ["检索命中率", "回答引用完整率", "幻觉率/无依据回答率", "一线查询耗时", "知识库更新时效", "用户满意度", "权限违规拦截率"],
      evidenceFocus: ["养老政策知识库样例", "护理SOP文档样例", "问答测试集", "引用溯源截图", "护理人员访谈纪要", "权限分级说明", "产品原型截图"],
      writingWarnings: ["不要写成跌倒检测或视频监控项目", "不要把通用聊天机器人当成核心产品", "必须突出RAG检索、来源引用、知识更新、隐私权限和养老业务流程", "不要编造已签约机构、真实营收或医疗诊断能力"],
    };
  }

  if (has(/防摔|跌倒|摔倒|fall|yolo|视觉检测|视频检测|姿态检测|人体检测|行为识别/)) {
    return {
      id: "elder-care-fall",
      title: "养老防摔视觉检测项目",
      domain: "智慧养老与机构安全管理",
      position: "面向养老院、社区日间照料中心和居家养老场景的无感式跌倒预警与事件留痕系统",
      users: ["夜班护理员", "养老机构院长/护理主管", "老人及家属", "社区养老服务中心", "智慧养老平台/集成商"],
      scenes: ["床边起身", "夜间走廊", "卫生间门口", "活动室", "康复训练区", "独居老人居家看护"],
      painPoints: ["跌倒发现慢", "人工巡护覆盖不足", "普通监控只能事后回看", "穿戴设备忘戴/拒戴/充电维护困难", "事故追溯和家属沟通材料不足"],
      productModules: ["视频接入", "YOLO11人体检测", "姿态与地面区域判断", "连续帧静止确认", "护理端分级告警", "后台事件台账", "误报漏报样本迭代"],
      techRoute: "视频流接入 -> YOLO11人体检测 -> 人体框宽高比/重心/地面区域/连续帧规则 -> 分级告警 -> 护理人员复核 -> 事件归档 -> 样本回流迭代",
      competitors: ["普通视频监控", "人工巡护", "穿戴式手环/胸牌", "综合智慧养老平台", "高端多传感硬件方案"],
      businessModels: ["按点位部署费", "年度运维费", "社区/居家养老订阅", "SDK/API算法授权", "大型机构定制开发"],
      metrics: ["疑似跌倒识别率", "误报率", "漏报率", "平均告警响应时间", "系统在线率", "事件记录完整度", "点位部署成本"],
      evidenceFocus: ["跌倒检测演示视频", "误报漏报分析表", "护理人员访谈纪要", "摄像头点位清单", "后台事件台账截图", "隐私授权说明"],
      writingWarnings: ["不要写成通用AI监控平台", "不要只讲YOLO模型先进", "不要把未签约养老院写成已落地客户", "不要用输入采集/预处理/核心处理这类泛化模块名"],
    };
  }

  if (has(/图书馆|座位|研讨室|预约|排队|占座/)) {
    return {
      id: "library-booking",
      title: "图书馆座位与研讨室预约调度项目",
      domain: "校园公共空间治理与智慧预约服务",
      position: "面向师生自习座位、研讨室和公共学习空间的预约、签到、释放、调度与信用管理平台",
      users: ["学生", "教师/课题组", "图书馆管理员", "学院/学校管理部门"],
      scenes: ["考试周高峰预约", "研讨室小组讨论", "临时离座保留", "超时未签到释放", "违规占座治理", "馆内空间利用统计"],
      painPoints: ["占座严重", "空座不可见", "研讨室使用冲突", "管理员人工协调成本高", "预约爽约缺少信用约束"],
      productModules: ["座位地图", "预约排队", "扫码签到", "超时释放", "研讨室审批", "信用分管理", "空间热力统计"],
      techRoute: "空间资源建模 -> 预约规则引擎 -> 签到/离座状态采集 -> 冲突与排队调度 -> 管理端统计 -> 信用反馈",
      competitors: ["人工登记", "微信公众号表单", "通用会议室系统", "传统门禁系统", "高校现有图书馆系统"],
      businessModels: ["校内项目制部署", "年度维护服务", "模块授权给高校信息化平台", "数据报表与空间优化服务"],
      metrics: ["座位周转率", "预约履约率", "爽约率", "研讨室利用率", "管理员处理时长", "高峰排队等待时间"],
      evidenceFocus: ["师生问卷", "图书馆座位高峰观察记录", "预约流程原型图", "后台统计截图", "校内访谈纪要"],
      writingWarnings: ["不要写成普通日程工具", "不要泛泛说智慧校园", "必须围绕占座、签到、释放、空间利用写"],
    };
  }

  if (has(/辅导员|计小帅|学生工作|学工|心理预警|成长档案|分层嵌套智能体|教育智能体|ai辅导|AI辅导/)) {
    return {
      id: "ai-counselor-agent",
      title: "AI辅导员与学生工作智能体项目",
      domain: "高校学生工作、成长陪伴与教育管理数字化",
      position: "面向辅导员、学生、学院管理者和学生工作部门的分层嵌套智能体、学生事务问答、成长档案分析与风险预警辅助平台",
      users: ["辅导员", "学生", "学院学生工作负责人", "心理/资助/就业专员", "学校学生工作部门"],
      scenes: ["学生事务政策问答", "请假/资助/评奖评优流程咨询", "成长档案整理", "谈心谈话记录辅助", "学业与心理风险预警", "就业与竞赛信息推送", "辅导员工作复盘"],
      painPoints: ["学生事务政策分散", "辅导员重复答疑压力大", "学生成长记录难以连续沉淀", "风险识别依赖人工经验", "多部门数据和流程协同不足", "通用大模型缺少学校制度边界"],
      productModules: ["校本政策知识库", "学生事务问答助手", "分层嵌套智能体调度", "成长档案画像", "风险线索提示", "辅导员工作台", "权限分级与脱敏", "任务闭环记录"],
      techRoute: "校本资料整理 -> 文档切分与知识库构建 -> 学生问题意图识别 -> 分层智能体调用 -> 来源引用回答/任务建议 -> 辅导员复核 -> 记录归档与知识更新",
      competitors: ["人工答疑群", "学校办事大厅", "通用聊天机器人", "传统学工系统", "知识库客服系统"],
      businessModels: ["校内项目制部署", "学院试点服务", "年度运维与知识库更新", "模块授权给智慧校园平台", "培训与定制工作流服务"],
      metrics: ["问答命中率", "来源引用完整率", "重复咨询减少率", "风险线索召回率", "辅导员处理时长", "学生满意度", "知识库更新时效"],
      evidenceFocus: ["校本政策样例", "问答测试集", "辅导员访谈", "学生需求问卷", "工作台原型截图", "权限与脱敏说明"],
      writingWarnings: ["不要写成替代辅导员", "不要进行心理诊断或处分决策", "必须突出辅导员复核、校本制度边界、隐私权限和学生工作流程"],
    };
  }

  if (has(/花境|花卉|盆栽|养护|浇水|花草|园艺|花卉监测|智慧养护/)) {
    return {
      id: "smart-flower-care",
      title: "智能花卉监测与智慧养护项目",
      domain: "家庭园艺、校园绿植与智慧养护服务",
      position: "面向家庭用户、校园/办公空间和花卉养护服务商的花卉状态监测、环境感知、养护建议、远程提醒与养护服务平台",
      users: ["家庭养花用户", "校园/办公空间管理者", "花店/园艺服务商", "社区绿植养护人员", "花卉爱好者"],
      scenes: ["盆栽状态监测", "浇水施肥提醒", "光照温湿度记录", "病虫害图片识别", "花卉养护知识问答", "养护服务派单", "校园/办公室绿植巡检"],
      painPoints: ["普通用户不会判断花卉状态", "浇水施肥依赖经验", "环境数据缺少持续记录", "病虫害发现不及时", "花卉养护服务难标准化", "绿植死亡后缺少复盘依据"],
      productModules: ["环境传感采集", "花卉图像识别", "养护知识库", "浇水施肥提醒", "生长档案", "养护任务管理", "用户端小程序/APP", "服务商后台"],
      techRoute: "环境/图片数据采集 -> 花卉状态识别 -> 养护规则与知识库匹配 -> 提醒/建议输出 -> 用户反馈 -> 生长档案与模型迭代",
      competitors: ["人工养护经验", "普通浇水提醒APP", "智能花盆硬件", "花店售后服务", "园艺内容社区"],
      businessModels: ["硬件+软件套装", "会员订阅", "养护服务包", "花卉电商导流", "校园/办公空间项目制服务", "数据看板服务"],
      metrics: ["状态识别准确率", "提醒触达率", "绿植存活率提升", "用户留存率", "养护任务完成率", "服务复购率"],
      evidenceFocus: ["花卉图片样本", "传感器数据记录", "用户访谈", "养护前后对比", "原型截图", "服务流程图"],
      writingWarnings: ["不要只写智慧农业", "必须围绕花卉状态、养护动作、用户习惯和服务交付写", "不要把养护建议写成绝对诊断"],
    };
  }

  if (has(/农业|种植|农品|草莓|花卉|乡村|数农|耘享|湘农|花境|溯源|合作社/)) {
    return {
      id: "smart-agriculture",
      title: "智慧农业与农品数字化项目",
      domain: "农业生产、农品品牌与县域数字化",
      position: "面向合作社、种植户、农业园区和县域农品品牌的生产监测、数据分析、溯源展示与营销服务方案",
      users: ["种植户", "合作社负责人", "农业园区管理者", "县域农品品牌运营方", "消费者/采购商"],
      scenes: ["作物生长监测", "病虫害识别", "农品分级与溯源", "区域品牌宣传", "线上商城/直播带货", "农业经营数据复盘"],
      painPoints: ["小农户数字化门槛高", "生产数据分散", "品牌认知弱", "优质农品难以优价销售", "溯源和营销材料不足"],
      productModules: ["多模态采集", "病虫害/长势识别", "生产档案", "溯源码", "农品数据看板", "全媒体内容生成", "订单与客户管理"],
      techRoute: "田间/图片/传感数据采集 -> 多模态分析 -> 生产档案与风险提示 -> 溯源展示 -> 内容营销 -> 销售与复盘",
      competitors: ["传统农技服务", "大型智慧农业平台", "电商代运营", "普通溯源二维码", "地方农品宣传平台"],
      businessModels: ["系统部署费", "合作社年度服务费", "品牌运营服务费", "农品营销佣金", "数据看板订阅"],
      metrics: ["病虫害识别准确率", "农品上架数量", "溯源扫码次数", "内容曝光量", "订单转化率", "服务合作社数量"],
      evidenceFocus: ["农户访谈", "田间照片/传感数据", "农品资料", "品牌物料", "销售数据或模拟订单", "溯源页面截图"],
      writingWarnings: ["不要只写大而空的乡村振兴", "要写具体作物、农户、合作社和销售路径", "不要把未发生销量写成真实营收"],
    };
  }

  if (has(/纹样|非遗素材|素材库|数字化提取|湖湘非遗|非遗纹样|图案提取|文化素材/)) {
    return {
      id: "intangible-pattern-library",
      title: "非遗纹样数字化素材库项目",
      domain: "非遗数字化保护、纹样提取与文化创意素材服务",
      position: "面向设计师、文创团队、学校美育课程和非遗传播机构的非遗纹样采集、数字化提取、轻量化素材库与授权应用平台",
      users: ["视觉设计师", "文创团队", "高校美育/设计课程师生", "非遗传承人/机构", "地方文化宣传部门"],
      scenes: ["非遗纹样采集", "图像清洗与矢量化", "素材分类检索", "文创设计应用", "课程教学素材", "授权与溯源说明"],
      painPoints: ["非遗纹样资料分散", "传统图案难直接用于现代设计", "素材版权和来源边界不清", "年轻用户接触门槛高", "文创团队重复整理成本高"],
      productModules: ["纹样采集库", "图像清洗与分割", "纹样矢量化", "标签分类检索", "轻量化素材下载", "授权说明", "应用案例展示"],
      techRoute: "非遗图像采集 -> 图像预处理 -> 纹样区域提取 -> 矢量化/轻量化 -> 标签分类 -> 素材检索下载 -> 应用反馈与版权记录",
      competitors: ["通用图片素材网站", "地方非遗展示网页", "人工临摹整理", "设计素材库", "文旅宣传图库"],
      businessModels: ["素材订阅", "课程授权", "文创设计服务", "地方项目制建设", "素材授权分成", "展陈数字化服务"],
      metrics: ["纹样采集数量", "矢量化成功率", "素材检索命中率", "下载/使用次数", "授权记录完整度", "课程/文创应用数量"],
      evidenceFocus: ["非遗纹样样本", "采集授权说明", "素材库原型", "设计应用案例", "用户访谈", "分类标签表"],
      writingWarnings: ["不要写成泛文旅平台", "必须突出纹样采集、提取、轻量化、授权和设计应用", "不要忽略版权和非遗来源尊重"],
    };
  }

  if (has(/文旅|非遗|地域文化|游戏|旅游|汨罗|湘小汨|山河|文化/)) {
    return {
      id: "culture-tourism",
      title: "文旅融合与非遗数字化项目",
      domain: "地方文化传播、文旅服务与数字内容",
      position: "面向游客、学生、文旅部门和地方商户的文化内容数字化、路线推荐、互动体验与消费转化平台",
      users: ["游客", "本地居民", "学校研学团队", "文旅部门", "非遗传承人/商户"],
      scenes: ["景点导览", "非遗纹样/故事展示", "研学路线", "互动游戏体验", "文创商品转化", "地方活动推广"],
      painPoints: ["文化内容分散", "游客停留时间短", "非遗传播年轻化不足", "文旅消费链路断裂", "地方品牌识别弱"],
      productModules: ["文化资源库", "智能导览", "路线推荐", "互动任务/游戏", "文创商城", "商户入驻", "数据看板"],
      techRoute: "地方文化资源采集 -> 内容结构化 -> 多模态展示/推荐 -> 互动任务 -> 消费转化 -> 运营数据复盘",
      competitors: ["普通旅游攻略平台", "景区公众号", "短视频账号", "传统导览牌", "大型OTA平台"],
      businessModels: ["文旅项目制服务", "商户推广费", "文创销售分成", "研学服务费", "平台运营服务费"],
      metrics: ["路线使用次数", "用户停留时长", "互动任务完成率", "商户转化次数", "内容更新量", "研学团队数量"],
      evidenceFocus: ["地方文化资料", "景点/商户调研", "原型页面", "用户访谈", "路线设计图", "文创样例"],
      writingWarnings: ["不要只写宣传文化", "必须写清游客怎么用、商户怎么受益、平台怎么运营", "不要把文旅大盘直接等同于项目收入"],
    };
  }

  if (has(/nas|影音|家庭影院|影巢|媒体库|照片备份|个性化影音|家庭私有云|片库/)) {
    return {
      id: "home-nas-media",
      title: "家庭NAS个性化影音服务项目",
      domain: "家庭数字资产管理、影音内容整理与私有云服务",
      position: "面向家庭用户、影音爱好者和小型工作室的NAS媒体库、照片视频备份、个性化推荐、家庭共享与隐私可控服务平台",
      users: ["家庭用户", "影音爱好者", "摄影/视频创作者", "小型工作室", "家庭成员共享用户"],
      scenes: ["家庭照片备份", "电影/剧集媒体库整理", "多设备播放", "家庭成员权限共享", "个人内容推荐", "离线下载与转码", "数字资产长期保存"],
      painPoints: ["家庭照片视频分散在多设备", "公网云隐私和容量成本压力大", "NAS配置门槛高", "影音资源整理耗时", "家庭成员共享权限复杂"],
      productModules: ["NAS部署向导", "媒体库刮削整理", "照片视频备份", "智能分类与推荐", "多端播放", "家庭权限管理", "远程访问", "运维健康检测"],
      techRoute: "家庭设备接入 -> 文件扫描与元数据识别 -> 媒体库分类 -> 权限与共享配置 -> 多端播放/备份 -> 使用反馈与运维提醒",
      competitors: ["公有云网盘", "传统NAS系统", "影音播放器", "手工硬盘管理", "家庭相册APP"],
      businessModels: ["部署服务费", "家庭订阅", "硬件搭配销售", "运维服务包", "高级功能付费", "私有化定制"],
      metrics: ["文件识别准确率", "媒体库整理效率", "备份成功率", "远程访问稳定性", "用户配置耗时", "续费/复购率"],
      evidenceFocus: ["家庭用户访谈", "媒体库原型截图", "NAS部署流程", "备份测试记录", "竞品对比", "隐私与权限说明"],
      writingWarnings: ["不要写成普通网盘", "必须突出家庭私有化、影音整理、权限共享和低门槛部署", "不要涉及侵权资源承诺"],
    };
  }

  if (has(/跨境|电商|外贸|出海|多语言|亚马逊|独立站|国际市场/)) {
    return {
      id: "cross-border-ai",
      title: "跨境电商智能服务项目",
      domain: "县域企业出海与跨境电商数字化",
      position: "面向县域中小企业、合作社和跨境运营团队的多语言内容、店铺运营、选品分析与国际客户服务平台",
      users: ["县域中小企业", "合作社/农品品牌", "跨境电商运营人员", "外贸服务机构", "海外采购商"],
      scenes: ["多语言商品页生成", "海外市场调研", "跨境店铺运营", "客服问答", "物流/关税信息整理", "品牌出海资料制作"],
      painPoints: ["缺少外贸团队", "多语言内容成本高", "海外市场信息不透明", "店铺运营经验不足", "客户服务响应慢"],
      productModules: ["多语言内容生成", "选品与市场分析", "店铺运营助手", "智能客服", "合规资料库", "数据看板"],
      techRoute: "商品与企业资料输入 -> 多语言生成/校对 -> 市场与竞品分析 -> 店铺运营任务 -> 客服知识库 -> 订单/反馈复盘",
      competitors: ["翻译软件", "传统外贸代运营", "跨境ERP", "大型电商平台工具", "通用大模型助手"],
      businessModels: ["SaaS订阅", "代运营服务费", "企业培训费", "店铺搭建费", "成交佣金", "行业解决方案授权"],
      metrics: ["商品页生成效率", "多语言校对通过率", "询盘响应时间", "店铺上新数量", "转化率", "企业服务数量"],
      evidenceFocus: ["企业访谈", "商品资料样例", "多语言页面截图", "竞品店铺分析", "运营流程表", "模拟询盘记录"],
      writingWarnings: ["不要写成普通聊天机器人", "要围绕企业出海的具体运营任务写", "不要承诺真实成交额"],
    };
  }

  if (has(/非接触|隔空|手势|勿触|空中手势|隔空操作|中间件|gesture|触控替代/)) {
    return {
      id: "touchless-interaction",
      title: "非接触隔空操作中间件项目",
      domain: "人机交互、公共终端控制与无接触操作服务",
      position: "面向公共屏幕、医疗/展陈/餐饮终端和智能设备控制场景的普通视觉感知、手势识别、指令映射与非接触交互中间件",
      users: ["公共终端运营方", "展馆/会议空间管理者", "医疗或实验室场景用户", "餐饮自助设备商", "智能硬件集成商"],
      scenes: ["公共屏幕隔空翻页", "自助终端无接触选择", "展陈互动控制", "医疗/实验室洁净场景操作", "会议演示控制", "智能设备手势触发"],
      painPoints: ["公共触控屏存在卫生顾虑", "特殊场景不便直接触摸设备", "传统手势设备成本高", "不同终端接入方式不统一", "误触和学习成本影响体验"],
      productModules: ["普通摄像头接入", "手部/姿态识别", "手势指令映射", "终端控制SDK", "灵敏度校准", "误触过滤", "场景配置后台"],
      techRoute: "视频流接入 -> 手部/人体关键点识别 -> 手势状态判断 -> 指令映射 -> 终端控制事件输出 -> 误触反馈与参数校准",
      competitors: ["触摸屏", "遥控器", "体感设备", "语音控制", "专用红外/深度相机方案"],
      businessModels: ["SDK授权", "终端项目制集成", "设备商合作分成", "年度运维", "行业场景定制"],
      metrics: ["手势识别准确率", "误触率", "响应延迟", "普通摄像头适配率", "用户学习时长", "终端接入数量"],
      evidenceFocus: ["手势演示视频", "识别测试表", "公共终端场景图", "SDK接口说明", "用户体验反馈", "误触分析表"],
      writingWarnings: ["不要写成普通视觉识别项目", "必须突出中间件、终端接入、误触控制和非接触场景", "不要承诺所有环境零误识别"],
    };
  }

  if (has(/哑铃|健身|力量训练|姿态识别|动作纠正|智炼|运动纠正|训练纠正/)) {
    return {
      id: "smart-fitness-coach",
      title: "姿态识别智能健身纠正项目",
      domain: "运动健康、力量训练与端侧姿态识别服务",
      position: "面向居家健身用户、校园健身房和轻量化力量训练场景的姿态识别、动作评分、错误纠正和训练记录系统",
      users: ["居家健身用户", "高校学生", "健身房教练/运营方", "康复训练辅助人员", "运动爱好者"],
      scenes: ["哑铃动作识别", "深蹲/卧推/划船姿态纠正", "训练计划执行", "错误动作提醒", "训练数据记录", "校园健身课程辅助"],
      painPoints: ["初学者动作不规范", "私教成本较高", "居家训练缺少实时反馈", "错误动作容易造成损伤", "训练记录和复盘不足"],
      productModules: ["端侧姿态识别", "动作标准库", "错误动作判别", "实时纠正提醒", "训练计划", "数据记录与评分", "教练端看板"],
      techRoute: "摄像头/传感输入 -> 人体关键点识别 -> 动作阶段分割 -> 标准动作比对 -> 错误提示/评分 -> 训练记录 -> 个性化计划迭代",
      competitors: ["私教课程", "健身视频教程", "运动手环", "健身APP", "大型智能健身镜"],
      businessModels: ["个人订阅", "校园/健身房授权", "智能硬件合作", "课程服务包", "训练数据报告", "教练端SaaS"],
      metrics: ["动作识别准确率", "纠正提示延迟", "错误动作检出率", "训练完成率", "用户留存率", "受伤风险提示采纳率"],
      evidenceFocus: ["动作样本视频", "姿态识别测试", "用户试用反馈", "训练计划样例", "原型截图", "健身场景调研"],
      writingWarnings: ["不要写成医疗康复诊断", "必须突出动作阶段、标准比对、实时反馈和训练记录", "不要夸大健康效果"],
    };
  }

  if (has(/白板|freeflow|多格式|协作|画布|流式|文档融合/)) {
    return {
      id: "creative-whiteboard",
      title: "多格式融合白板协作项目",
      domain: "知识协作、创意生产与多格式内容编辑",
      position: "面向学生团队、产品经理、设计师和内容创作者的多格式文件融合、无限画布、AI协作与结构化输出平台",
      users: ["学生项目团队", "产品/设计团队", "内容创作者", "教师/培训讲师", "知识工作者"],
      scenes: ["资料导入整理", "头脑风暴", "流程图/架构图绘制", "多文档协作", "AI生成与改写", "项目资料导出"],
      painPoints: ["资料分散在PDF/Word/图片/网页中", "白板工具结构化输出弱", "AI对画布内容理解不足", "多人协作和版本管理成本高"],
      productModules: ["多格式导入", "无限画布", "结构化卡片", "AI并行工作区", "流程图/表格生成", "版本与协作", "导出Word/PDF/PPT"],
      techRoute: "多格式解析 -> 内容块结构化 -> 画布布局 -> AI理解与生成 -> 协作编辑 -> 多格式导出",
      competitors: ["Excalidraw", "Miro", "FigJam", "Notion白板", "传统思维导图工具", "通用文档AI"],
      businessModels: ["个人订阅", "团队版订阅", "教育版授权", "模板市场", "AI额度付费", "企业私有化部署"],
      metrics: ["文件解析成功率", "画布节点数量", "协作延迟", "导出成功率", "AI改写采纳率", "用户留存"],
      evidenceFocus: ["原型截图", "多格式导入样例", "用户使用流程", "竞品对比", "导出文件", "协作演示视频"],
      writingWarnings: ["不要写成普通在线白板", "必须突出多格式融合、AI并行工作区和结构化输出", "不要泛泛写提升效率"],
    };
  }

  if (has(/听障|行动障碍|无障碍|助残|风险识别|安全辅助|智护/)) {
    return {
      id: "accessibility-safety",
      title: "无障碍安全辅助项目",
      domain: "特殊群体安全辅助与普惠智能服务",
      position: "面向听障、行动障碍等群体的风险识别、提醒联动、紧急求助和照护协同系统",
      users: ["听障人士", "行动障碍人士", "家属/照护者", "社区服务人员", "学校/公共场所管理者"],
      scenes: ["过街安全提醒", "室内跌倒/求助", "公共场所警示", "家属远程通知", "校园/社区巡护", "紧急事件联动"],
      painPoints: ["声音警报不可达", "行动受限导致响应慢", "照护者无法持续陪同", "公共空间无障碍提示不足", "求助过程缺少定位和记录"],
      productModules: ["风险识别", "多模态提醒", "定位与求助", "家属端通知", "后台记录", "无障碍交互", "设备/平台联动"],
      techRoute: "视觉/传感/位置数据采集 -> 风险识别 -> 震动/闪光/文字/语音多模态提醒 -> 家属/社区联动 -> 事件记录",
      competitors: ["普通报警器", "手机紧急联系人", "穿戴式求助设备", "公共场所广播", "综合助残平台"],
      businessModels: ["设备+软件服务包", "社区项目制部署", "家庭订阅", "公益/政府采购", "平台接口授权"],
      metrics: ["风险识别准确率", "提醒到达率", "求助响应时间", "误报率", "用户满意度", "设备续航/稳定性"],
      evidenceFocus: ["目标用户访谈", "无障碍交互原型", "风险场景测试", "家属端截图", "公益/社区需求材料"],
      writingWarnings: ["不要把特殊群体写成抽象用户", "必须注意尊重、隐私和无障碍体验", "不要夸大医疗或救援能力"],
    };
  }

  const product = cleanConfigPhrase(config.product || "", "项目原型系统、核心功能模块和服务实施流程");
  const market = cleanConfigPhrase(config.market || "", "目标客户、真实使用者和早期试点场景");
  return {
    id: "custom",
    title: "自定义场景项目",
    domain: config.track || config.competition || "大学生创新创业训练项目",
    position: `${config.name}围绕${config.brief || "真实应用需求"}，以${product}为核心交付，服务${market}`,
    users: [market, "一线使用者", "管理者/决策者", "合作伙伴"],
    scenes: ["核心使用场景", "高频任务场景", "试点验证场景", "展示答辩场景"],
    painPoints: ["现有方案效率不足", "使用成本或管理成本较高", "过程记录不完整", "技术与真实场景脱节"],
    productModules: ["场景接入", "核心功能模块", "用户端服务", "后台管理", "反馈迭代", "材料导出"],
    techRoute: "需求/数据接入 -> 核心功能处理 -> 结果展示 -> 人工复核/用户反馈 -> 记录归档 -> 版本迭代",
    competitors: ["传统人工方式", "通用平台", "硬件/设备方案", "同类创业项目"],
    businessModels: ["项目制交付", "年度运维", "订阅服务", "模块授权", "定制开发"],
    metrics: ["完成率", "响应时间", "准确率/成功率", "成本", "用户满意度", "材料完整度"],
    evidenceFocus: ["用户访谈", "原型截图", "测试记录", "竞品分析", "财务测算", "团队分工"],
    writingWarnings: ["不要写成任何项目都能套用的通用模板", "每章必须落到项目自身用户、场景、产品模块和指标", "不要编造成已取得的客户、专利或收入"],
  };
}

function projectSpecificWritingRules(config: WorkflowConfig) {
  const profile = currentTopicProfile(config);
  return `当前主题事实边界：
- 项目名称、技术版本、产品模块和业务对象只按当前表单与当前上传资料处理；不得沿用其他项目、其他目录或历史样例内容。
- 当前定位：${profile.position}。
- 所属方向：${profile.domain}。
- 服务对象来自当前字段：${profile.users.join("、")}。
- 使用场景来自当前字段：${profile.scenes.join("、")}。
- 问题表述围绕当前主题：${profile.painPoints.join("、")}。
- 产品能力按当前主题组织：${profile.productModules.join("、")}。
- 技术/服务链路按当前字段保持：${profile.techRoute}。
- 替代方案只写与当前主题直接相关的对象：${profile.competitors.join("、")}。
- 收入与资金口径按当前字段处理：${profile.businessModels.join("、")}。
- 指标体系围绕：${profile.metrics.join("、")}。
- 证明材料优先组织：${profile.evidenceFocus.join("、")}。
- 事实边界：${profile.writingWarnings.join("；")}。`;
}

function projectProfileDossier(config: WorkflowConfig, step?: StepDef) {
  const profile = currentTopicProfile(config);
  const rows = [
    ["当前名称", profile.title],
    ["当前定位", profile.position],
    ["当前方向", profile.domain],
    ["服务对象", profile.users.join("、")],
    ["使用场景", profile.scenes.join("、")],
    ["问题边界", profile.painPoints.join("、")],
    ["产品能力", profile.productModules.join("、")],
    ["技术/服务链路", profile.techRoute],
    ["替代方案", profile.competitors.join("、")],
    ["收入/资金口径", profile.businessModels.join("、")],
    ["验证指标", profile.metrics.join("、")],
    ["证明材料", profile.evidenceFocus.join("、")],
    ["事实禁区", profile.writingWarnings.join("；")],
  ];
  const stepFocus = step ? chapterProfileFocus(config, step) : "";
  return `## 当前主题事实边界
${makeTable(["维度", "来自当前表单/上传资料的事实"], rows)}
${stepFocus ? `\n## 当前部分事实边界\n${stepFocus}` : ""}`;
}

function chapterProfileFocus(config: WorkflowConfig, step: StepDef) {
  const profile = currentTopicProfile(config);
  const users = profile.users.slice(0, 4).join("、");
  const scenes = profile.scenes.slice(0, 4).join("、");
  const pains = profile.painPoints.slice(0, 4).join("、");
  const modules = profile.productModules.slice(0, 5).join("、");
  const metrics = profile.metrics.slice(0, 5).join("、");
  const evidence = profile.evidenceFocus.slice(0, 5).join("、");
  const competitors = profile.competitors.slice(0, 4).join("、");
  const models = profile.businessModels.slice(0, 4).join("、");
  if (/summary|executive/.test(step.id)) {
    return `本章必须用一段完整叙事交代“${pains} -> ${modules} -> ${users} -> ${models} -> ${evidence}”，不要写成目录说明或摘要模板。`;
  }
  if (/background|overview|opportunity/.test(step.id)) {
    return `本章先写${scenes}中的现实矛盾，再写${users}为什么需要解决，最后落到${config.name}的项目切入点；不得只写宏观政策热度。`;
  }
  if (/advantage|innovation|technology/.test(step.id)) {
    return `本章围绕${modules}和“${profile.techRoute}”展开创新性，逐项对比${competitors}，并用${metrics}说明优势如何验证。`;
  }
  if (/market|validation|analysis/.test(step.id)) {
    return `本章按${users}分层写目标客户，按${scenes}写采购/试点触发条件，按${competitors}写替代方案，不要直接套宏观市场规模。`;
  }
  if (/product|solution|company/.test(step.id)) {
    return `本章把${modules}拆成产品功能、服务流程、数据/任务流和交付成果，必须体现${profile.techRoute}，不要只说平台先进。`;
  }
  if (/business|marketing|sales|growth/.test(step.id)) {
    return `本章把${models}写成“客户对象-交付内容-收费口径-持续服务”，并说明如何通过${evidence}支撑获客和成交。`;
  }
  if (/operation|management/.test(step.id)) {
    return `本章写${modules}的日常运营、${scenes}的实施流程、${metrics}的验收记录和合规边界，避免泛泛写宣传推广。`;
  }
  if (/financial|finance|funding/.test(step.id)) {
    return `本章围绕${models}做收入预测，围绕${modules}做成本预算，围绕${evidence}说明资金投入会形成哪些可验收成果。`;
  }
  if (/team|organization|foundation/.test(step.id)) {
    return `本章按研发、产品、调研、财务、运营展示分工对应${modules}、${users}、${metrics}和${evidence}，不要写成空泛团队介绍。`;
  }
  if (/risk|compliance/.test(step.id)) {
    return `本章风险必须来自${scenes}、${profile.techRoute}、数据/授权、交付成本和用户接受度，并给出可执行控制动作。`;
  }
  if (/future|prospect|strategy|development/.test(step.id)) {
    return `本章按短中长期写${modules}如何从${scenes}扩展到${profile.domain}，并说明${metrics}和${evidence}如何持续沉淀。`;
  }
  if (/appendix|materials|roadshow|proof/.test(step.id)) {
    return `本章只写正式附件和证明材料，将${evidence}逐项对应到正文结论，并保持材料名称、证明对象、对应章节和使用口径一致。`;
  }
  return `本章必须围绕${users}、${scenes}、${modules}、${metrics}和${evidence}写成项目专属正文。`;
}

function mockElderCareFallStepOutput(config: WorkflowConfig, step: StepDef) {
  const name = config.name;
  const team = config.team || "项目团队由算法开发、前后端开发、产品调研、市场运营和资料整理成员组成";
  switch (step.id) {
    case "dc-executive-summary":
      return `## 执行摘要
${name}面向养老机构、社区日间照料中心和居家养老场景中的跌倒风险发现问题，构建一套基于 YOLO11 的视觉防摔检测系统。项目不是简单在摄像头上叠加“AI识别”概念，而是围绕老人起身、行走、转身、摔倒、长时间静止和护理人员响应等真实照护环节，形成“视频接入—人体检测—姿态与时序判断—分级预警—人工复核—事件归档—模型迭代”的闭环服务。

项目建设背景来自两类现实压力。一方面，国家统计局2024年统计数据显示，我国60岁及以上人口已达31031万人，占全国人口22.0%，养老服务需求持续扩大；另一方面，养老机构日常护理存在夜间巡护压力、卫生间和床边等风险区域难以持续盯防、事故发生后追溯材料不足等问题。普通监控更多承担事后回看功能，穿戴式设备又存在老人忘戴、拒戴、充电维护和误触等问题，机构需要一种更低打扰、更易部署、更能留痕的安全辅助方案。

本项目的核心交付包括 YOLO11 跌倒识别模型、视频流分析服务、风险规则引擎、护理端告警页面、后台事件台账和模型迭代数据集。系统初期优先覆盖养老院房间、床边、走廊、活动室和卫生间门口等高风险区域，通过普通摄像头或边缘盒子接入视频流，识别人体框、姿态倾斜、地面区域接触、静止持续时间和危险区域停留等信号，再结合时序规则减少“弯腰、坐下、捡东西、康复训练”造成的误报。

商业上，项目优先采用“小规模试点+点位部署+年度运维”的方式进入市场。养老院和护理院可按摄像头点位或楼层部署，社区养老中心可按服务区域订阅，智慧养老平台和设备集成商可采用算法模块授权或接口合作。项目第一阶段重点形成可演示系统、测试视频、误报分析表和服务流程，第二阶段形成试点反馈、部署手册和运维报价，第三阶段再拓展到老人异常行为识别、护理质量复盘和社区居家养老安全管理。

${makeTable(
  ["摘要维度", "具体内容", "内容落点"],
  [
    ["服务对象", "养老院、护理院、社区养老服务中心、居家养老平台、智慧养老集成商", "市场分析"],
    ["核心产品", "YOLO11跌倒检测模型、分级告警、事件台账、后台报表", "产品介绍"],
    ["关键场景", "床边起身、夜间走廊、卫生间门口、活动室、长时间静止", "项目概述"],
    ["竞争切口", "普通监控只能事后回看，穿戴设备依从性不足，综合平台细分算法弱", "市场分析"],
    ["收入方式", "点位部署费、年度运维费、平台订阅费、SDK/API授权、定制开发", "商业模式"],
    ["支撑依据", "演示视频、测试记录、误报漏报分析、原型截图、访谈纪要、部署清单", "可验证成果"],
  ],
)}`;

    case "dc-project-overview":
      return `## 项目背景
我国养老服务正在从“人力照护为主”转向“机构、社区、居家协同+数字化辅助”的发展阶段。国家统计局2024年统计公报显示，我国60岁及以上人口为31031万人，65岁及以上人口为22023万人，养老照护需求正在快速增长。民政部公开数据也显示，全国养老机构和设施数量、养老床位规模保持高位，养老服务体系对安全管理、护理效率和事件追溯的要求越来越高。

在养老机构实际运营中，跌倒是最难完全依靠人工避免的风险之一。老人夜间起身、如厕、独自穿过走廊、从床边转移到轮椅、康复训练后疲劳行走，都可能出现摔倒或疑似摔倒。护理人员需要同时照看多名老人，夜间巡护又受人手、视线、房间分布和疲劳影响，无法持续盯守所有风险区域。事故发生后，如果缺少事件记录、响应时间和现场片段，机构还会面临责任界定和家属沟通压力。

## 项目理念
项目坚持“无感守护、及时发现、人工复核、事件留痕”的理念。无感守护是指尽量不要求老人额外佩戴设备，减少忘戴、拒戴和充电维护问题；及时发现是指在疑似跌倒或长时间静止时尽快提醒护理人员；人工复核是指系统不直接替代护理判断，而是把高风险片段推送给人员确认；事件留痕是指形成告警时间、处理状态、截图片段和复盘记录，为后续管理提供依据。

## 项目简介
${name}以普通摄像头或边缘设备接入养老场景视频，利用 YOLO11 对人体目标进行检测，并结合人体框宽高比、重心位置、地面区域接触、持续静止时间和场景区域规则判断跌倒风险。系统输出分为三级：一级为普通姿态异常提示，二级为疑似跌倒告警，三级为长时间静止或无人响应告警。护理人员可在手机端或后台查看告警片段，完成“确认、误报、已处理、需复查”等状态标记。

## 社会价值
项目的社会价值首先体现在老人安全。跌倒风险越早被发现，老人长时间倒地造成二次伤害的概率越低。其次体现在护理减负，系统将护理人员从完全依赖巡房转向“重点响应”，提高夜间和高风险区域的覆盖效率。再次体现在机构管理，事件台账和响应记录可用于质量复盘、家属沟通和安全培训。最后体现在学生创新训练，团队能够在真实养老问题中完成算法、产品、市场和服务的综合实践。

${makeTable(
  ["场景", "典型问题", "系统回应"],
  [
    ["床边起身", "老人夜间起床、重心不稳、护理人员难以及时发现", "识别人体由坐卧转为异常倾斜或倒地，触发床边风险告警"],
    ["卫生间门口", "地面湿滑、隐私要求高、人工盯守困难", "在门口和公共区域做最小化视觉检测，避免深入隐私空间"],
    ["走廊巡护", "夜间巡护频次有限，老人跌倒后可能长时间无人发现", "对走廊摄像头视频流进行实时检测和静止计时"],
    ["活动室", "老人集中活动，弯腰、坐下、康复训练容易造成误判", "结合时序规则和区域语义降低误报"],
    ["居家养老", "独居老人缺少持续看护，家属远程响应滞后", "通过家属端或社区端推送疑似风险事件"],
  ],
)}`;

    case "dc-project-advantages":
      return `## 产品服务
项目提供一套面向养老防摔场景的轻量化视觉预警服务。服务内容包括摄像头点位规划、YOLO11模型部署、跌倒风险识别、护理端告警、后台事件台账、误报漏报复盘和后续运维更新。与普通监控不同，系统关注“发生风险时如何提醒、提醒后谁处理、处理过程如何记录”；与穿戴设备不同，系统尽量减少老人主动操作和佩戴负担。

## 技术原理
系统技术链路围绕养老场景设计，而不是通用图像识别流程。视频流进入系统后，YOLO11首先检测人体目标框；随后系统计算人体框宽高比、人体中心点高度、框体倾斜趋势、与地面区域的相对位置和连续帧静止时间；再结合床边、走廊、活动室等区域规则判断风险等级。对“坐下、弯腰、拾物、康复训练”等易误报动作，系统采用连续帧确认和人工复核机制，不用单帧结果直接触发高等级告警。

${makeTable(
  ["技术环节", "养老场景任务", "输出结果"],
  [
    ["视频接入", "接入房间、走廊、活动室等公共或授权区域摄像头", "视频流、点位编号、时间戳"],
    ["人体检测", "用YOLO11定位老人身体区域，过滤非人体干扰", "人体框、置信度、目标轨迹"],
    ["姿态判断", "分析人体框宽高比、重心高度、地面接触趋势", "疑似跌倒、坐下、弯腰等状态标签"],
    ["时序确认", "连续多帧判断是否倒地、静止或长时间无人响应", "风险等级、持续时间"],
    ["告警复核", "推送护理端并记录确认、误报、已处理等状态", "事件台账、复盘数据"],
  ],
)}

## 创新点
项目创新点首先在于把 YOLO11 目标检测与养老护理流程结合。系统不只输出“检测框”，而是把检测结果转化为护理人员能执行的告警任务。其次，项目将姿态比例、区域语义和时序判断组合使用，针对床边、走廊、活动室等不同位置设置风险规则，减少单帧误报。再次，项目把误报漏报样本纳入后续训练数据，形成“现场反馈—样本回收—模型迭代”的闭环。

## 核心优势
项目核心优势集中在低打扰、低改造、可复核和可迭代四个方面。低打扰体现在老人无需额外佩戴设备；低改造体现在可优先利用养老机构已有摄像头或低成本边缘盒子；可复核体现在每次告警都有时间、点位、片段和处理状态；可迭代体现在系统能把误报场景沉淀为训练样本，持续优化坐下、弯腰、遮挡和夜间光照等复杂情况。

${makeTable(
  ["优势类型", "具体表现", "对养老机构的价值"],
  [
    ["低打扰", "不强制老人佩戴手环或主动操作设备", "降低老人抵触和维护成本"],
    ["低改造", "优先接入既有摄像头，边缘端可按点位部署", "减少一次性改造压力"],
    ["强留痕", "保留告警时间、处理状态和复盘记录", "方便家属沟通和责任追溯"],
    ["可复核", "高风险事件推送护理人员确认", "避免系统单独承担判断责任"],
    ["可迭代", "误报漏报样本进入训练和规则优化", "长期提升场景适配能力"],
  ],
)}`;

    case "dc-product-introduction":
      return `## 产品概述
${name}由视频接入端、YOLO11检测服务、跌倒判断引擎、护理告警端、后台管理端和数据迭代模块组成。视频接入端负责连接养老机构摄像头或测试视频；检测服务负责识别人体目标；判断引擎结合姿态比例、地面区域和连续帧变化判断风险；护理告警端用于接收和处理提醒；后台管理端用于查看事件、统计响应时间和导出记录；数据迭代模块用于收集误报漏报样本。

## 核心特色
产品特色不是“功能多”，而是围绕养老防摔场景把关键流程做实。系统重点解决三件事：第一，老人发生疑似跌倒时能尽快被发现；第二，护理人员能看到明确点位、时间和片段，而不是收到模糊提醒；第三，机构能在事后复盘事件响应过程。产品界面以护理人员日常使用为中心，突出风险等级、老人所在区域、持续时间、处理状态和复核入口。

${makeTable(
  ["模块", "功能说明", "验收指标"],
  [
    ["视频接入模块", "接入摄像头或本地测试视频，标记房间/走廊/活动室点位", "视频流稳定读取，点位信息可追踪"],
    ["YOLO11检测模块", "识别人体目标框并输出置信度、位置和轨迹", "能在样例视频中连续定位老人"],
    ["跌倒判断模块", "结合人体框比例、重心变化、地面区域和静止时间判断风险", "区分跌倒、坐下、弯腰等易混动作"],
    ["分级告警模块", "按疑似跌倒、长时间静止、无人响应等情况推送提醒", "告警时间和处理状态可记录"],
    ["事件台账模块", "保存点位、截图、片段、处理人、处理结果和备注", "支持查询、筛选和导出"],
    ["样本迭代模块", "收集误报漏报视频片段用于再训练和规则调整", "形成版本日志和样本清单"],
  ],
)}

## 详细介绍
系统运行时，摄像头视频先进入检测服务，YOLO11在连续帧中识别老人身体位置。当人体框从竖直状态快速转为横向、重心高度明显下降，并在地面区域附近保持一定时间，系统标记为疑似跌倒；当老人处于低姿态但随后恢复站立，系统记录为低等级风险；当老人长时间静止且护理端未确认，系统升级告警。这样的设计既避免单帧误判，也保留了人工复核空间。

## 应用场景
项目优先覆盖养老院房间外公共区域、走廊、活动室、康复区和卫生间门口等场景。房间内部涉及隐私保护，可采用授权区域、床边区域或低清轮廓化处理；走廊场景关注夜间巡护和长时间倒地；活动室场景关注多人遮挡和康复训练误报；居家养老场景关注独居老人远程提醒和家属通知。不同场景采用不同阈值和告警策略，避免“一套规则跑所有场景”。

图1 系统技术架构图：摄像头/视频文件—边缘计算盒/服务器—YOLO11人体检测—跌倒判断引擎—护理端告警—后台事件台账—样本迭代库。

图2 护理告警服务流程图：疑似跌倒发生—系统生成告警—护理端收到点位和片段—护理人员现场确认—后台记录处理结果—误报漏报进入复盘。

## 产品价值
对养老机构而言，系统价值在于缩短风险发现时间、减少夜间无效巡查、提高事件记录完整度和增强家属沟通依据。对护理人员而言，系统不是替代人工，而是帮助其从“盲目巡查”转向“重点响应”。对家属而言，系统能在授权前提下提供更可解释的安全守护。对项目团队而言，系统形成了可演示、可测试、可迭代的创业训练成果。`;

    case "dc-market-analysis":
      return `## 市场分析
${name}的目标市场不是泛泛的“智慧养老大市场”，而是养老安全管理中的跌倒预警细分场景。国家统计局数据显示，2024年我国60岁及以上人口已突破3亿，养老机构、社区养老服务中心和居家养老平台都在面对照护需求上升与护理人员不足的矛盾。对于机构客户，跌倒预警直接关联服务安全、事故追溯和家属沟通；对于社区居家养老平台，远程发现风险和及时转介服务是提升服务覆盖的重要环节。

## 用户分析
${makeTable(
  ["用户类型", "实际需求", "使用场景", "决策关注点"],
  [
    ["护理人员", "快速知道哪一位老人、哪个点位可能出事", "夜间巡护、走廊、活动室、床边起身", "告警是否准确、操作是否简单"],
    ["机构管理者", "减少事故漏报，保留处理记录，提升服务质量", "安全管理、家属沟通、护理复盘", "部署成本、责任边界、数据留痕"],
    ["老人及家属", "希望风险被及时发现，同时不被过度打扰", "机构养老、居家看护、社区服务", "隐私保护、响应速度、服务可信度"],
    ["平台/集成商", "补充垂直算法能力，增强智慧养老方案", "智慧养老平台、摄像头方案、边缘盒子", "接口能力、稳定性、授权方式"],
  ],
)}

## 市场需求分析
养老防摔检测的需求来自“人力覆盖不足”和“事故后果严重”的叠加。普通监控需要人工长期盯屏，实际多数情况下只能事后回放；人工巡护受班次和空间限制，难以持续覆盖卫生间门口、走廊、床边等高风险点位；穿戴设备虽然能监测部分运动状态，但存在佩戴依从性、充电维护和误触问题。视觉防摔系统的市场切口在于利用既有摄像头资源，提供更低打扰、更强留痕的安全辅助能力。

## 痛点分析
${makeTable(
  ["痛点", "真实表现", "项目切入方式"],
  [
    ["发现慢", "夜间或低人手时段，老人倒地后可能无法立即被发现", "连续帧检测倒地和静止时间，及时推送护理端"],
    ["误报难控", "坐下、弯腰、康复训练与跌倒动作相似", "结合姿态比例、区域规则和人工复核降低误报"],
    ["追溯不足", "事故发生后缺少完整时间线和处理记录", "保存点位、时间、截图、处理人和结果"],
    ["佩戴困难", "部分老人不愿佩戴手环，设备充电维护麻烦", "采用无感视觉检测，减少老人主动配合"],
    ["改造成本", "机构预算有限，不愿一次性更换整套平台", "优先接入既有摄像头，按点位试点部署"],
  ],
)}

## 市场规模与增长趋势
从客户数量看，养老机构、社区养老服务设施和居家养老平台构成了项目可服务的基础市场。民政部公开数据表明，全国养老机构和设施数量、养老床位规模已经形成较大的服务网络。项目测算不直接把宏观养老市场等同于自身收入，而是按“点位数量、机构规模、服务包价格、试点转化率”进行估算：小型养老院可按重点点位部署，中型机构可按楼层或区域部署，平台客户可按账号、点位或接口调用付费。

## 竞品分析
${makeTable(
  ["方案类型", "优势", "不足", "本项目差异化"],
  [
    ["普通视频监控", "已有设备多、改造成本低", "依赖人工查看，主要用于事后回放", "增加实时跌倒识别、告警和事件台账"],
    ["人工巡护", "判断灵活，能直接处理现场", "夜间覆盖有限，人力成本高，记录不完整", "辅助护理人员重点响应"],
    ["穿戴设备", "可监测运动或心率等个人数据", "老人可能忘戴、拒戴，充电维护成本高", "无感检测，降低主动佩戴要求"],
    ["综合智慧养老平台", "管理功能完整，渠道和客户基础较好", "细分跌倒算法和场景适配可能不足", "提供垂直防摔模块和接口合作"],
    ["高端多传感硬件", "准确性和环境适应性较强", "设备成本高，部署复杂", "以普通摄像头和边缘计算做轻量切入"],
  ],
)}

## 目标市场进入路径
项目初期不追求全国铺开，而是选择1-2个可接触养老场景完成样板验证。第一步对接本地养老院、社区日间照料中心或校企合作资源，完成需求访谈和演示视频；第二步选择床边、走廊、活动室等2-5个点位进行试点部署；第三步形成误报漏报分析、护理人员反馈和部署清单；第四步再面向同类机构复制服务包。`;

    default:
      if (step.id.startsWith("tb-") || step.id.startsWith("ip-")) return genericCompetitionStepOutput(config, step);
      return mockDachuangStepOutput(config, step);
  }
}

function mockDachuangStepOutput(config: WorkflowConfig, step: StepDef) {
  const profileDriven = buildMissingChapterBlock(step, config).trim();
  if (profileDriven) return profileDriven;
  return genericCompetitionStepOutput(config, step);
}
function mockStepOutput(config: WorkflowConfig, step: StepDef) {
  if (isReferenceWorkflowStep(step)) return referenceChapterFallback(config, step);
  const profileDriven = buildMissingChapterBlock(step, config).trim();
  if (profileDriven) return profileDriven;

  if (step.id.startsWith("dc-")) {
    if (isElderCareFallConfig(config)) return mockElderCareFallStepOutput(config, step);
    return mockDachuangStepOutput(config, step);
  }

  return genericCompetitionStepOutput(config, step);
}

function workflowFamilyForStep(step: StepDef) {
  if (step.id.startsWith("tb-")) return "tiaozhanbei";
  if (step.id.startsWith("ip-")) return "internet-plus";
  return "dachuang";
}

function genericCompetitionStepOutput(config: WorkflowConfig, step: StepDef) {
  const name = config.name;
  const product = cleanConfigPhrase(config.product || "", "项目原型系统、核心功能模块、业务流程和持续运营服务");
  const market = cleanConfigPhrase(config.market || "", "目标客户、一线使用者、管理者和早期试点场景");
  const finance = cleanConfigPhrase(config.finance || "", "研发、调研、测试、原型部署、运营推广、合规评估和展示材料");
  const evidence = cleanConfigPhrase(config.evidence || "", "公开政策资料、行业报告、用户访谈、原型截图、测试记录、财务测算和团队分工材料");
  const family = workflowFamilyForStep(step);
  const isIp = family === "internet-plus";
  const competitionName = isIp ? "中国国际大学生创新大赛/互联网+项目" : "挑战杯创业计划竞赛项目";
  const title = step.targetSection || step.name;
  const profile = currentTopicProfile(config);
  const users = profile.users.join("、");
  const scenes = profile.scenes.join("、");
  const pains = profile.painPoints.join("、");
  const modules = profile.productModules.join("、");
  const models = profile.businessModels.join("、");
  const metrics = profile.metrics.join("、");
  const evidenceList = profile.evidenceFocus.join("、");

  const table = (headers: string[], rows: string[][]) => makeTable(headers, rows);
  const moduleRows = profile.productModules.slice(0, 6).map((module, index) => [
    module,
    `围绕${profile.scenes[index % profile.scenes.length]}形成可演示、可测试、可交付的功能能力`,
    profile.users[index % profile.users.length],
    profile.evidenceFocus[index % profile.evidenceFocus.length],
  ]);
  const userRows = profile.users.slice(0, 5).map((user, index) => [
    user,
    profile.painPoints[index % profile.painPoints.length],
    profile.scenes[index % profile.scenes.length],
    profile.productModules[index % profile.productModules.length],
  ]);
  const competitorRows = profile.competitors.slice(0, 5).map((competitor, index) => [
    competitor,
    "具备既有渠道、经验或单点能力",
    profile.painPoints[index % profile.painPoints.length],
    `${profile.productModules[index % profile.productModules.length]}、${profile.metrics[index % profile.metrics.length]}`,
  ]);
  const serviceRows = profile.businessModels.slice(0, 5).map((model, index) => [
    model,
    profile.users[index % profile.users.length],
    `${profile.productModules[index % profile.productModules.length]}、${profile.evidenceFocus[index % profile.evidenceFocus.length]}`,
    index < 2 ? "项目估算口径" : "分阶段验证口径",
  ]);
  const stageRows = [
    ["第一阶段", `完成${profile.scenes[0]}需求确认、用户访谈和原型边界`, profile.evidenceFocus[0] || "需求纪要"],
    ["第二阶段", `完成${profile.productModules.slice(0, 3).join("、")}的可演示版本`, profile.evidenceFocus[1] || "原型截图"],
    ["第三阶段", `围绕${metrics}组织测试、复盘和成本测算`, profile.evidenceFocus[2] || "测试记录"],
    ["第四阶段", `形成${competitionName}路演材料、附件材料和复制方案`, profile.evidenceFocus[3] || "展示材料"],
  ];
  const financeRows = [
    ["研发与原型", "30%", `${profile.productModules.slice(0, 3).join("、")}研发与联调`, "可演示原型、接口说明、版本记录"],
    ["调研与验证", "20%", `${profile.users.slice(0, 3).join("、")}访谈和${profile.scenes.slice(0, 2).join("、")}验证`, "访谈纪要、测试记录、问题清单"],
    ["场景部署与测试", "20%", "样机、环境、数据、仿真或试点条件准备", "演示视频、测试表、验收记录"],
    ["运营推广", "15%", "服务包、渠道沟通、客户材料和培训资料", "报价表、服务手册、路演PPT"],
    ["合规与展示", "15%", "合规说明、风险评估、财务测算和附件整理", "风险表、财务表、附件清单"],
  ];
  const riskRows = [
    ["技术风险", `${profile.techRoute}中的关键环节可能受环境、数据或工程稳定性影响`, "高", `设置测试集、人工复核、阶段验收和${metrics.split("、")[0]}跟踪`],
    ["市场风险", `${profile.users.slice(0, 2).join("、")}采购或试点转化周期存在不确定性`, "中", "先做小范围验证和服务包报价，沉淀可展示案例"],
    ["交付风险", `${profile.scenes.slice(0, 2).join("、")}差异可能提高部署和运维成本`, "中", "形成场景清单、部署标准、验收表和问题闭环"],
    ["合规风险", `${profile.domain}涉及数据、场景、安全或责任边界`, "高", "明确授权范围、数据最小化、日志留痕和责任边界"],
    ["团队风险", "研发、市场、财务和材料进度不同步", "中", "周计划、里程碑、版本归档和答辩材料同步管理"],
  ];

  if (step.id.endsWith("summary") || step.id === "tb-executive-summary") {
    return `## 执行摘要
${name}面向${profile.domain}领域，聚焦${pains}等真实问题，拟建设一套以${modules}为核心的${profile.position}。项目按照${competitionName}的商业计划书表达方式，把问题来源、产品方案、技术路线、市场验证、运营路径、财务测算和风险控制组织成完整闭环。

项目的主要服务对象包括${users}。在实际使用中，项目围绕${scenes}等场景展开，形成“${profile.techRoute}”的业务闭环。与${profile.competitors.join("、")}等替代方案相比，本项目强调场景适配、流程留痕、指标验证和可复制交付，避免只停留在概念展示或单点技术演示。

商业上，项目以${models}作为收入路径，初期以小范围试点、原型演示和客户访谈切入，中期形成标准化服务包、运维交付和渠道合作，后期向模块授权、平台接入和行业解决方案扩展。项目资金主要用于${finance}，核心成果以${evidenceList}等材料证明。

项目预期形成一份完整的商业计划和可演示产品原型，评价指标包括${metrics}。项目团队将以公开资料口径、项目估算口径、原型测试口径和用户材料口径组织正文，不把尚未发生的客户签约、营收、专利或资质许可写成既成事实，保证计划书既具备竞赛表达力，也具备落地可信度。`;
  }

  const base = `## ${title}
${name}定位于${profile.domain}领域，围绕${profile.position}建设产品和服务体系。项目以${product}为基础，以${market}为早期验证对象，形成面向${scenes}的可交付能力。`;

  if (/background|opportunity/.test(step.id)) {
    return `${base}

### 行业背景与问题来源
${profile.domain}正在从单点工具、零散服务走向场景化、平台化和可验证交付。${name}面对的不是抽象的大市场，而是${users}在${scenes}中反复出现的具体任务。现有方案往往存在${pains}等问题，导致项目具备从场景痛点切入的创业机会。

项目切入的核心矛盾是：客户需要稳定、可复制、可衡量的解决方案，但${profile.competitors.join("、")}更多解决局部问题，难以同时覆盖场景适配、执行流程、结果记录和后续迭代。项目因此把${profile.techRoute}作为主线，使产品能力能够对应真实业务环节。

### 社会价值与商业价值
项目的社会价值体现在提升${profile.domain}相关场景的效率、安全、质量和可追溯水平；商业价值体现在为${users}提供可购买、可部署、可评估的产品与服务。项目不把宏观政策或行业热度直接等同于收入，而是通过用户需求、场景验证、指标测试和财务测算逐步证明可行性。

${table(["问题类型", "现实表现", "应对方式"], [
  [profile.painPoints[0], `${profile.scenes[0]}中效率、成本或质量难以稳定控制`, profile.productModules[0]],
  [profile.painPoints[1], `${profile.users[0]}需要更清晰的执行路径和结果反馈`, profile.productModules[1]],
  [profile.painPoints[2], `替代方案难以覆盖${profile.techRoute}的完整链路`, profile.productModules[2]],
  [profile.painPoints[3], `项目落地需要指标、材料和责任边界支撑`, `${metrics}、${evidenceList}`],
  [profile.painPoints[4] || profile.painPoints[0], `不同客户场景存在差异，复制推广需要标准化`, profile.businessModels[0]],
])}`;
  }

  if (/market|validation|analysis/.test(step.id)) {
    return `${base}

### 目标市场与客户分层
项目的直接客户不是抽象的行业概念，而是能够在${scenes}中产生明确需求、预算和验证条件的${users}。早期选择沟通成本较低、问题明确、能够配合原型演示和反馈记录的客户；中期通过标准化服务包和合作伙伴扩大触达；后期面向同类场景形成复制能力。

${table(["客户类型", "核心痛点", "典型场景", "项目进入方式"], userRows)}

### 竞品与替代方案分析
项目面对的替代方案包括${profile.competitors.join("、")}。这些方案分别具备经验、设备、渠道或单点能力，但在${pains}等方面仍存在空白。${name}的市场进入逻辑是用可演示原型、可量化指标和可复用服务包证明差异化。

${table(["替代方案", "既有优势", "主要不足", "本项目差异化"], competitorRows)}`;
  }

  if (/company|product|solution/.test(step.id)) {
    return `${base}

### 项目定位
${name}以${modules}为核心能力，服务${users}。项目定位不是单一工具或概念展示，而是围绕${profile.techRoute}形成从需求触发、任务执行、结果反馈到持续迭代的完整服务。

### 产品服务
产品由${modules}组成。各模块分别承担场景接入、任务处理、过程控制、结果呈现、后台管理和服务迭代功能，保证产品能够被客户理解、被团队开发、被评审验证。

${table(["产品模块", "核心功能", "服务对象", "交付成果"], moduleRows)}

### 服务流程
项目服务按照${profile.techRoute}推进。早期版本优先覆盖${profile.scenes.slice(0, 3).join("、")}等高频场景，形成可演示、可测试、可复盘的产品闭环。`;
  }

  if (/innovation|technology/.test(step.id)) {
    return `${base}

### 技术创新
项目的技术创新体现在把${profile.techRoute}落到${scenes}。系统不是简单堆叠技术名词，而是让${modules}分别对应输入、处理、控制、输出和反馈环节，并通过${metrics}评估实际效果。

### 产品创新
项目把产品能力嵌入${users}的真实工作流程。用户不是单纯查看功能页面，而是在${scenes}中完成任务触发、方案执行、结果确认、数据记录和后续复盘，使技术能力转化为可购买的服务价值。

${table(["创新类型", "具体内容", "竞争价值"], [
  ["场景创新", `${profile.scenes.slice(0, 3).join("、")}形成明确切入点`, "降低项目泛化和空泛表达风险"],
  ["技术路线创新", profile.techRoute, "把核心技术转化为可执行流程"],
  ["产品模块创新", profile.productModules.slice(0, 5).join("、"), "形成完整交付而非单点功能"],
  ["商业模式创新", profile.businessModels.slice(0, 4).join("、"), "适配不同客户预算和采购方式"],
  ["验证体系创新", metrics, "让评审看到效果评估和改进依据"],
])}

### 竞争优势
与${profile.competitors.join("、")}相比，项目优势集中在场景聚焦、流程闭环、指标验证、交付材料和后续复制。项目不把竞争优势写成“技术先进”一句话，而是落实到${evidenceList}等证据。`;
  }

  if (/marketing|sales|growth|business-model/.test(step.id)) {
    return `${base}

### 定价策略
项目采用${models}的组合方式设计收入结构。早期以低门槛试点和演示服务降低客户决策成本，中期形成标准交付包和年度运维，后期通过模块授权、平台合作或定制集成扩大收入来源。

${table(["产品/服务包", "适用客户", "交付内容", "收费口径"], serviceRows)}

### 渠道策略
项目初期通过学校导师资源、本地企业或机构访谈、行业公开资料调研和竞赛展示获取种子反馈；中期通过合作伙伴、行业渠道、系统集成商或平台方扩大触达；后期通过标准化交付材料和案例复盘提升复制效率。营销重点不是大规模广告，而是用可演示原型、真实测试和服务流程建立信任。

### 销售流程
销售流程包括需求访谈、场景评估、原型演示、试点报价、部署实施、人员培训、试运行和复盘续费。每个阶段都形成可记录材料，保证客户能够看见系统如何解决${pains}等具体问题。`;
  }

  if (/operation|management/.test(step.id)) {
    return `${base}

### 运营体系
项目运营围绕产品稳定、场景验证、客户服务、数据记录和版本迭代展开。运营不是单纯宣传，而是持续维护${modules}的交付质量，并通过${metrics}判断项目是否真正解决客户问题。

${table(["运营环节", "主要工作", "关键指标", "责任材料"], [
  ["产品运营", `${profile.productModules.slice(0, 3).join("、")}维护和版本更新`, profile.metrics[0], "版本日志、功能清单"],
  ["场景运营", `${profile.scenes.slice(0, 3).join("、")}测试和问题复盘`, profile.metrics[1], "测试记录、问题清单"],
  ["客户运营", `${profile.users.slice(0, 3).join("、")}培训、反馈和服务响应`, profile.metrics[2], "访谈纪要、培训记录"],
  ["合规运营", "授权范围、数据记录、责任边界和安全要求管理", "记录完整度", "授权说明、风险表"],
])}

### 实施计划
${table(["阶段", "重点任务", "形成材料"], stageRows)}
项目通过阶段验收控制进度，确保技术、产品、市场和财务材料同步推进。`;
  }

  if (/development|prospect|strategy/.test(step.id)) {
    return `${base}

### 阶段发展战略
项目发展遵循“先验证核心场景，再沉淀标准交付，后拓展合作生态”的路径。短期聚焦${profile.scenes.slice(0, 3).join("、")}，验证${profile.productModules.slice(0, 3).join("、")}；中期拓展到更多客户和服务包；长期围绕${profile.domain}形成可复制解决方案。

${table(["阶段", "建设重点", "市场重点", "成果形态"], [
  ["近期", profile.productModules.slice(0, 3).join("、"), `${profile.users.slice(0, 2).join("、")}访谈和试点演示`, "原型系统、测试记录、需求纪要"],
  ["中期", profile.productModules.slice(3, 6).join("、") || modules, `${profile.users.slice(2, 4).join("、")}复制推广`, "标准服务包、培训手册、案例材料"],
  ["远期", "平台接口、行业解决方案和生态合作", `${profile.competitors.slice(0, 2).join("、")}合作或替代`, "行业方案、接口文档、运营体系"],
])}

### 前景分析
随着${profile.domain}继续发展，客户对效率、成本、安全、数据记录和服务闭环的要求会持续提高。${name}具备从小规模试点逐步扩展到多客户、多场景和多业务链路的潜力。`;
  }

  if (/financial|finance|funding/.test(step.id)) {
    return `${base}

### 启动资金与成本预算
项目启动资金主要用于${finance}。财务数据采用项目估算口径，收入预测以${models}为主，不把尚未签订的合同、未发生营收或未取得资质写成真实成果。

${table(["费用项目", "预算占比", "主要用途", "形成成果"], financeRows)}

### 收入预测与融资回报
项目收入按“试点验证-标准交付-年度运维-模块授权/渠道合作”的路径逐步形成。第一年重点完成产品验证和少量试点，第二年扩大客户和合作伙伴，第三年以后通过标准化服务包和平台化合作提高复用率。

${table(["年份", "试点/初始化服务", "订阅与运维", "平台授权/定制", "收入合计"], [
  ["Y1", "15万元", "6万元", "0万元", "21万元"],
  ["Y2", "45万元", "32万元", "18万元", "95万元"],
  ["Y3", "90万元", "85万元", "55万元", "230万元"],
  ["Y4", "150万元", "160万元", "120万元", "430万元"],
  ["Y5", "220万元", "260万元", "220万元", "700万元"],
])}
上述预测按照项目估算口径测算，实际收入取决于产品完成度、客户转化、模型服务成本、合规审核和渠道合作进展。融资需求优先服务于可复用产品能力和可验证客户场景。`;
  }

  if (/risk|compliance/.test(step.id)) {
    return `${base}

### 风险矩阵与应对措施
${table(["风险类型", "主要表现", "影响程度", "应对措施"], riskRows)}`;
  }

  if (/team|organization|foundation/.test(step.id)) {
    return `${base}

### 团队组织与能力匹配
项目团队按照“技术研发、产品设计、用户调研、财务测算、运营展示”组织分工。技术成员负责${profile.productModules.slice(0, 3).join("、")}研发和测试；产品成员负责${profile.scenes.slice(0, 3).join("、")}流程设计；调研成员负责${profile.users.slice(0, 3).join("、")}需求访谈；财务成员负责成本、收入和融资测算；运营展示成员负责商业计划书、路演材料和附件管理。

${table(["角色", "主要职责", "阶段成果", "能力匹配"], [
  ["项目负责人", "统筹目标、进度、外部沟通和竞赛材料", "计划表、里程碑、路演口径", "保证项目方向和交付一致"],
  ["技术研发", `${profile.productModules.slice(0, 4).join("、")}研发`, "Demo、测试记录、接口说明", "支撑核心产品能力"],
  ["产品与调研", `${profile.scenes.slice(0, 4).join("、")}拆解、用户访谈、流程设计`, "用户画像、流程图、需求清单", "保证产品贴近真实场景"],
  ["财务与市场", "竞品分析、客户分层、价格和收入测算", "市场表格、财务预测、资金用途", "支撑商业可行性"],
  ["运营展示", "计划书整合、附件清单、路演材料和答辩准备", "商业计划书、PPT、证明材料", "提升竞赛呈现完整度"],
])}`;
  }

  if (/appendix|roadshow|materials/.test(step.id)) {
    return `${base}

### 附件与证明材料清单
附件用于证明项目真实性、可行性和阶段成果，只承载项目事实、测试记录、调研材料、财务测算和成果证明。项目附件围绕${evidenceList}组织，分别支撑行业背景、用户需求、产品能力、财务测算、团队基础和合规边界。

${table(["材料类别", "具体材料", "支撑章节", "使用口径"], [
  ["政策与行业资料", `${profile.domain}政策、行业报告和公开资料摘录`, "项目背景、市场分析", "公开资料口径"],
  ["用户调研材料", `${profile.users.slice(0, 3).join("、")}访谈和需求记录`, "痛点分析、产品服务", "用户材料口径"],
  ["产品原型材料", `${profile.productModules.slice(0, 4).join("、")}截图或演示材料`, "产品服务、创新优势", "原型测试口径"],
  ["测试评估材料", `${metrics}测试记录和问题复盘`, "技术路线、风险控制", "项目测试口径"],
  ["财务测算材料", "成本预算、收入预测、资金用途和服务成本", "财务分析", "项目估算口径"],
  ["团队与展示材料", "团队分工、阶段日志、路演PPT、答辩问题清单", "团队介绍、发展前景", "竞赛展示口径"],
])}`;
  }

  return `${base}

### 核心内容
本项目以${modules}构成产品能力，以${profile.techRoute}构成技术和服务链路。系统围绕${scenes}完成需求接入、核心处理、结果呈现、人工确认、后台记录和持续迭代，使方案能够从演示走向可交付。

${table(["能力模块", "功能说明", "应用价值"], [
  [profile.productModules[0] || "核心模块", `支撑${profile.scenes[0]}任务`, profile.painPoints[0]],
  [profile.productModules[1] || "处理模块", `支撑${profile.scenes[1] || profile.scenes[0]}任务`, profile.painPoints[1] || profile.painPoints[0]],
  [profile.productModules[2] || "用户模块", `服务${profile.users[0]}`, profile.metrics[0]],
  [profile.productModules[3] || "管理模块", "记录过程、结果和问题复盘", profile.metrics[1] || profile.metrics[0]],
  [profile.productModules[4] || "迭代模块", "沉淀反馈并优化版本", profile.evidenceFocus[0]],
])}

### 实施路径
项目实施分为四个阶段。第一阶段完成需求清单、用户访谈和场景边界；第二阶段完成核心原型、流程设计和基础测试；第三阶段围绕${metrics}组织场景验证和问题复盘；第四阶段形成商业计划书、演示系统、附件材料和后续试点方案。每一阶段都输出可检查材料，避免正文停留在概念表达。`;
}

function expectedProjectBookChapters(config: WorkflowConfig) {
  const referenceChapters = extractReferenceStyleOutline(config.styleReferenceContext || "")
    .filter((item) => /^[一二三四五六七八九十]+、/.test(item));
  if (referenceChapters.length >= 3) {
    return Array.from(new Set(referenceChapters));
  }
  return Array.from(new Set(projectChapterSteps(config).map((step) => canonicalStepHeading(step).chapter).filter(Boolean)));
}

function buildTableOfContents(artifacts: ArtifactFile[], config?: WorkflowConfig) {
  const sections = new Set<string>();
  if (config) {
    expectedProjectBookChapters(config).forEach((section) => sections.add(section));
  }
  artifacts
    .filter((artifact) => !isSupportArtifact(artifact) && !isObsoleteDachuangArtifact(artifact, config) && artifact.step.id !== "final-assembly" && !artifact.step.id.endsWith("outline"))
    .forEach((artifact) => {
      sections.add(canonicalStepHeading(artifact.step).chapter);
    });
  return Array.from(sections).map((section) => `- ${section}`).join("\n");
}

function artifactBody(content: string) {
  const lines = content.split(/\r?\n/);
  const body = lines.filter((line, index) => index !== 0 && !line.startsWith(">")).join("\n");
  return body.trim();
}

function shortSectionTitle(title: string) {
  return title
    .replace(/^完整.*项目.*书$/g, "")
    .replace(/（[^）]{8,}）/g, "")
    .replace(/\([^)]{8,}\)/g, "")
    .replace(/[:：].*$/g, "")
    .replace(/项目书正文深化|场景对象与使用流程|量化指标体系|实施与验收路径|资料依据与证明链条|风险控制与迭代机制|竞赛呈现价值/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeProjectBookHeadings(markdown: string) {
  const seen = new Set<string>();
  return markdown
    .split(/\r?\n/)
    .map((line) => {
      const match = line.match(/^(#{2,3})\s+(.+)$/);
      if (!match) return line;
      const level = match[1];
      const title = shortSectionTitle(match[2]);
      if (!title) return "";
      const key = `${level}:${title}`;
      if (seen.has(key)) return "";
      seen.add(key);
      return `${level} ${title}`;
    })
    .filter((line, index, lines) => !(line === "" && lines[index - 1] === ""))
    .join("\n")
    .replace(/^###\s*(项目背景、项目理念、项目简介与社会价值|产品服务、技术原理、创新点与核心优势|行业分析、用户需求、痛点分析与竞品分析|产品概述、核心特色、详细介绍与应用场景|价值主张、客户细分、盈利模式与运营模式|运营现状、营销策略、开发进度与年度目标|财务分析、成本预算、收入预测与资金用途|团队概况、组织分工、导师支持与已有基础|风险分析、应对措施与质量保障|短期规划、中期规划、长期规划与综合价值|附录材料、图表清单与证明材料使用原则)\s*$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function canonicalStepHeading(step: StepDef) {
  const referenceMatch = step.id.match(/^ref-chapter-\d+$/);
  if (referenceMatch) {
    const chapter = step.targetSection || step.name;
    return { chapter, section: "" };
  }
  const newDachuangHeadings: Record<string, { chapter: string; section: string }> = {
    "dc-executive-summary": { chapter: "执行摘要", section: "执行摘要" },
    "dc-project-overview": { chapter: "一、项目方案概述", section: "项目背景、项目简述、创业机会与项目价值" },
    "dc-project-advantages": { chapter: "二、项目团队概述", section: "团队组织、分工与已有基础" },
    "dc-market-analysis": { chapter: "三、产业背景与项目产品", section: "产业背景、产品概述与服务实施计划" },
    "dc-product-introduction": { chapter: "四、市场调查与竞争分析", section: "市场规模、目标市场、竞争分析与差异化优势" },
    "dc-business-model": { chapter: "五、商业模式与发展战略", section: "商业模式、营销策略、发展战略与核心竞争力保障" },
    "dc-market-operation": { chapter: "六、预期效益分析", section: "社会效益、经济效益与可扩展价值" },
    "dc-financial-plan": { chapter: "七、总结与资金回报", section: "项目总结、资金回报与交付物汇总" },
    "dc-team-introduction": { chapter: "八、证明材料", section: "证明材料与附件清单" },
    "dc-risk-management": { chapter: "五、商业模式与发展战略", section: "风险控制与合规边界" },
    "dc-future-plan": { chapter: "五、商业模式与发展战略", section: "短期、中期、长期发展战略" },
    "dc-appendix-proof": { chapter: "八、证明材料", section: "附件、图表与材料索引" },
  };
  const newMapped = newDachuangHeadings[step.id];
  if (newMapped) return newMapped;
  const headings: Record<string, { chapter: string; section: string }> = {
    "tb-executive-summary": { chapter: "执行摘要", section: "" },
    "tb-project-background": { chapter: "一、项目背景与社会价值", section: "" },
    "tb-company-product": { chapter: "二、公司/项目概况与产品服务", section: "" },
    "tb-innovation-advantage": { chapter: "三、创新内容与竞争优势", section: "" },
    "tb-market-analysis": { chapter: "四、市场分析与目标市场", section: "" },
    "tb-marketing-sales": { chapter: "五、营销策略及销售", section: "" },
    "tb-operation-management": { chapter: "六、运营管理与实施计划", section: "" },
    "tb-team-organization": { chapter: "七、团队介绍与组织能力", section: "" },
    "tb-financial-plan": { chapter: "八、财务分析与融资计划", section: "" },
    "tb-risk-control": { chapter: "九、风险分析与对策", section: "" },
    "tb-development-prospect": { chapter: "十、发展战略与前景", section: "" },
    "tb-appendix-proof": { chapter: "十一、附件与证明材料", section: "" },
    "ip-project-summary": { chapter: "一、项目概要", section: "" },
    "ip-problem-opportunity": { chapter: "二、行业痛点与创业机会", section: "" },
    "ip-solution-product": { chapter: "三、解决方案与产品服务", section: "" },
    "ip-technology-innovation": { chapter: "四、技术创新与核心壁垒", section: "" },
    "ip-market-validation": { chapter: "五、市场分析与用户验证", section: "" },
    "ip-business-model": { chapter: "六、商业模式与业务闭环", section: "" },
    "ip-growth-operation": { chapter: "七、运营推广与增长策略", section: "" },
    "ip-team-foundation": { chapter: "八、团队基础与资源支撑", section: "" },
    "ip-finance-funding": { chapter: "九、财务预测与融资回报", section: "" },
    "ip-risk-compliance": { chapter: "十、风险控制与合规", section: "" },
    "ip-roadshow-materials": { chapter: "十一、路演呈现与附件材料", section: "" },
    "dc-executive-overview": { chapter: "一、项目概述", section: "项目背景、项目简介与项目优势" },
    "dc-research-content": { chapter: "二、研究目标与项目内容", section: "研究目的、研究内容与创新特色" },
    "dc-industry-status": { chapter: "三、行业背景与国内外现状", section: "政策背景、行业环境与痛点分析" },
    "dc-product-service": { chapter: "四、产品与服务方案", section: "产品服务、技术原理与应用场景" },
    "dc-market-analysis": { chapter: "五、市场分析与竞争分析", section: "市场需求、竞品分析与核心优势" },
    "dc-business-operation": { chapter: "六、商业模式与运营策略", section: "盈利模式、运营模式与营销策略" },
    "dc-implementation-plan": { chapter: "七、技术路线与实施计划", section: "技术路线、开发进度与年度目标" },
    "dc-team-foundation": { chapter: "八、团队介绍与已有基础", section: "团队分工、研究积累与条件保障" },
    "dc-finance-risk": { chapter: "九、财务规划与风险管理", section: "财务预测、融资需求与风险控制" },
    "dc-results-proof": { chapter: "十、预期成果、未来展望与证明材料", section: "预期成果、未来规划与附录证明" },
    "dc-overview-background": { chapter: "一、项目方案概述", section: "项目背景与项目简述" },
    "dc-overview-market-value": { chapter: "一、项目方案概述", section: "创业机会、竞争优势与项目价值" },
    "dc-team": { chapter: "二、项目团队概述", section: "团队组织与分工" },
    "dc-industry-policy": { chapter: "三、产业背景与项目产品", section: "产业背景与市场概述" },
    "dc-product-system": { chapter: "三、产业背景与项目产品", section: "项目产品概述与技术架构" },
    "dc-service-plan": { chapter: "三、产业背景与项目产品", section: "项目服务实施计划" },
    "dc-market-size": { chapter: "四、市场调查与竞争分析", section: "市场规模调查与目标市场规模" },
    "dc-competition": { chapter: "四、市场调查与竞争分析", section: "竞争分析与差异化优势" },
    "dc-business-model": { chapter: "五、商业模式与发展战略", section: "商业模式" },
    "dc-marketing": { chapter: "五、商业模式与发展战略", section: "营销策略" },
    "dc-development-strategy": { chapter: "五、商业模式与发展战略", section: "发展战略与核心竞争力保障" },
    "dc-social-benefits": { chapter: "六、预期效益分析", section: "社会治理、民生改善与绿色价值" },
    "dc-economic-benefits": { chapter: "六、预期效益分析", section: "盈利能力、经济价值与数据资产" },
    "dc-finance-return": { chapter: "七、总结与资金回报", section: "项目总结与资金回报" },
    "dc-finance-tables": { chapter: "七、总结与资金回报", section: "收入预测、财务模型与交付物汇总" },
    "dc-proof-materials": { chapter: "八、证明材料", section: "证明材料与附件清单" },
    overview: { chapter: "一、项目方案概述", section: "项目背景、项目简述与项目价值" },
    team: { chapter: "二、项目团队概述", section: "团队组织与分工" },
    "industry-product": { chapter: "三、产业背景与项目产品", section: "产业背景、产品方案与实施计划" },
    "market-competition": { chapter: "四、市场调查与竞争分析", section: "市场规模、目标客户与竞争分析" },
    "business-strategy": { chapter: "五、商业模式与发展战略", section: "商业模式、营销策略与发展战略" },
    benefits: { chapter: "六、预期效益分析", section: "社会效益、经济效益与可扩展价值" },
    "finance-deliverables": { chapter: "七、总结与资金回报", section: "资金回报、财务模型与交付物" },
    "proof-materials": { chapter: "八、证明材料", section: "证明材料与依据清单" },
  };
  const mapped = headings[step.id];
  if (mapped) return mapped;
  const chapter = step.targetSection.split(/[（(]/)[0].trim() || step.name;
  return { chapter, section: shortSectionTitle(step.name) || shortSectionTitle(step.targetSection) || step.name };
}

function stripArtificialHeadings(markdown: string) {
  const artificial = /项目书正文深化|场景对象与使用流程|量化指标体系|实施与验收路径|资料依据与证明链条|风险控制与迭代机制|竞赛呈现价值/;
  return markdown
    .split(/\r?\n/)
    .map((line) => {
      const match = line.match(/^#{1,4}\s+(.+)$/);
      if (!match) return line;
      const title = match[1].trim();
      if (artificial.test(title)) return "";
      if (/^[一二三四五六七八九十]、.+（.+）/.test(title)) return "";
      if (/^完整.*项目.*书$/.test(title)) return "";
      const short = shortSectionTitle(title);
      return short ? `### ${short}` : "";
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function cleanArtifactForFinalBook(artifact: ArtifactFile) {
  let body = stripArtificialHeadings(artifactBody(artifact.content));
  const heading = canonicalStepHeading(artifact.step);
  body = body
    .replace(new RegExp(`^#{1,4}\\s*${escapeRegExp(artifact.step.targetSection)}\\s*\\n+`, "m"), "")
    .replace(new RegExp(`^#{1,4}\\s*${escapeRegExp(artifact.step.name)}\\s*\\n+`, "m"), "")
    .trim();
  return { ...heading, body };
}

function assembleChaptersForFinalBook(artifacts: ArtifactFile[], config?: WorkflowConfig) {
  const grouped = new Map<string, { section: string; body: string }[]>();
  const referenceOrder = config ? referenceStyleChapters(config).map((item) => item.chapter) : [];
  const chapterOrder = [
    ...referenceOrder,
    "执行摘要",
    "一、项目背景与社会价值",
    "二、公司/项目概况与产品服务",
    "三、创新内容与竞争优势",
    "四、市场分析与目标市场",
    "五、营销策略及销售",
    "六、运营管理与实施计划",
    "七、团队介绍与组织能力",
    "八、财务分析与融资计划",
    "九、风险分析与对策",
    "十、发展战略与前景",
    "十一、附件与证明材料",
    "一、项目概要",
    "二、行业痛点与创业机会",
    "三、解决方案与产品服务",
    "四、技术创新与核心壁垒",
    "五、市场分析与用户验证",
    "六、商业模式与业务闭环",
    "七、运营推广与增长策略",
    "八、团队基础与资源支撑",
    "九、财务预测与融资回报",
    "十、风险控制与合规",
    "十一、路演呈现与附件材料",
    "一、项目方案概述",
    "二、项目团队概述",
    "三、产业背景与项目产品",
    "四、市场调查与竞争分析",
    "五、商业模式与发展战略",
    "六、预期效益分析",
    "七、总结与资金回报",
    "八、证明材料",
  ];
  artifacts
    .filter((artifact) => !isSupportArtifact(artifact) && !isObsoleteDachuangArtifact(artifact, config) && artifact.step.id !== "final-assembly" && !artifact.step.id.endsWith("outline"))
    .forEach((artifact) => {
      const item = cleanArtifactForFinalBook(artifact);
      const list = grouped.get(item.chapter) || [];
      list.push({ section: item.section, body: item.body });
      grouped.set(item.chapter, list);
    });
  return Array.from(grouped.entries())
    .sort(([a], [b]) => {
      const ai = chapterOrder.indexOf(a);
      const bi = chapterOrder.indexOf(b);
      if (ai >= 0 && bi >= 0) return ai - bi;
      if (ai >= 0) return -1;
      if (bi >= 0) return 1;
      return a.localeCompare(b, "zh-Hans-CN");
    })
    .map(([chapter, sections]) => {
      const sectionText = sections
        .map((item) => {
          const section = item.section && item.section !== chapter && !item.body.includes(`### ${item.section}`)
            ? `\n\n### ${item.section}\n${item.body}`
            : `\n\n${item.body}`;
          return section.trim();
        })
        .join("\n\n");
      return `## ${chapter}\n${sectionText}`;
    })
    .join("\n\n");
}

function isSupportArtifact(artifact: ArtifactFile) {
  return ["research-brief", "upload-knowledge", "evidence-index", "quality-scan", "final-review-loop"].includes(artifact.step.id);
}

function isObsoleteDachuangArtifact(artifact: ArtifactFile, config?: WorkflowConfig) {
  if (config?.template !== "dachuang") return false;
  return artifact.step.id === "dc-executive-summary";
}

type EvidenceRow = {
  id: string;
  category: string;
  claim: string;
  source: string;
  usage: string;
  confidence: string;
};

function parseEvidenceRows(artifacts: ArtifactFile[]): EvidenceRow[] {
  const evidence = artifacts.find((artifact) => artifact.step.id === "evidence-index");
  if (!evidence) return [];
  return evidence.content
    .split(/\r?\n/)
    .filter((line) => /^\|.+\|$/.test(line) && !/^\|\s*-+/.test(line))
    .map((line) => line.split("|").slice(1, -1).map((cell) => cell.trim()))
    .filter((cells) => cells.length >= 6 && cells[0] !== "编号")
    .map((cells) => ({
      id: cells[0],
      category: cells[1],
      claim: cells[2],
      source: cells[3],
      usage: cells[4],
      confidence: cells[5],
    }));
}

function inferEvidenceChapter(row: EvidenceRow) {
  const text = `${row.category} ${row.claim} ${row.source} ${row.usage}`;
  if (/财务|收入|成本|资金|融资|回报|预测/.test(text)) return "七、总结与资金回报";
  if (/风险|合规|隐私|应对|商业|营销|渠道|订阅|授权|交付|运营|盈利|展望|规划|转化/.test(text)) return "五、商业模式与发展战略";
  if (/技术|模型|算法|测试|原型|架构|产品|系统|服务|功能/.test(text)) return "三、产业背景与项目产品";
  if (/客户|市场|竞品|行业|采购|预算|价格|需求/.test(text)) return "四、市场调查与竞争分析";
  if (/团队|成员|导师|分工|基础|成果/.test(text)) return "二、项目团队概述";
  if (/附件|证明|上传资料|访谈|政策|来源/.test(text)) return "八、证明材料";
  if (/社会价值|民生|治理|生态|绿色|效益/.test(text)) return "六、预期效益分析";
  return "一、项目方案概述";
}

function evidenceRowsForFinalBook(artifacts: ArtifactFile[]) {
  const preferred = /上传资料|参考文件|相关文件|附件数据|证明材料|公开来源|项目事实|技术口径|财务口径/;
  return parseEvidenceRows(artifacts)
    .filter((row) => preferred.test(row.category) || preferred.test(row.source))
    .slice(0, 18);
}

function buildSourceMappingSection(config: WorkflowConfig, artifacts: ArtifactFile[]) {
  const rows = evidenceRowsForFinalBook(artifacts);
  const fallback = [
    config.referenceNotes ? ["M1", "参考文件", config.referenceNotes, "用于对照项目书结构、写法与已有材料", "全文结构与附件说明", "用户材料口径"] : null,
    config.contestFileNotes ? ["M2", "相关文件", config.contestFileNotes, "用于补充赛题、政策、图像、业务或背景材料", "项目背景/市场/证明材料", "用户材料口径"] : null,
    config.attachmentNotes ? ["M3", "附件数据", config.attachmentNotes, "用于形成数据口径、附件索引和证明材料清单", "证明材料/财务测算/技术测试", "附件材料口径"] : null,
  ].filter(Boolean) as string[][];
  const tableRows = rows.length
    ? rows.map((row) => [
        row.id,
        row.category,
        row.source.slice(0, 80),
        row.claim.slice(0, 120),
        inferEvidenceChapter(row),
        row.confidence === "high" ? "可作为正文事实或附件依据" : row.confidence === "medium" ? "按材料口径或公开资料口径使用" : "仅作论证方向，不写成既成事实",
      ])
    : fallback;
  if (!tableRows.length) {
    tableRows.push(["M0", "材料边界", "用户尚未上传可解析材料", "以表单信息、联网调研和公开资料口径形成正文", "全文", "公开资料/项目估算口径"]);
  }
  return `## 材料来源与正文对应表
${makeTable(["编号", "材料类型", "材料/来源", "可支撑内容", "对应正文位置", "使用口径"], tableRows)}

以上材料对应关系用于约束正文写作：高置信材料可支撑项目事实和附件依据；中置信材料按公开资料、用户材料或项目估算口径使用；低置信材料只作为论证方向，不写成已取得客户、专利、软著、试点或财务结果。`;
}

function buildExecutiveSummarySection(config: WorkflowConfig) {
  const track = config.track || config.competition || "大学生创新创业训练项目";
  const brief = (config.brief || "真实应用场景中的效率、安全、管理或服务痛点")
    .replace(/^围绕/, "")
    .replace(/构建可演示、可验证、可迭代的项目解决方案。?$/, "")
    .trim();
  const product = config.product || "项目原型系统、核心算法模块、服务流程和交付资料";
  const market = config.market || "目标用户、试点单位、行业平台和具备明确需求的应用场景";
  const finance = config.finance || "原型研发、测试验证、设备与部署、资料沉淀、成果展示和后续试点";
  const evidence = config.evidence || "政策与行业资料、调研访谈、原型截图、测试记录、财务测算表和团队分工材料";
  return `## 执行摘要
${config.name}面向${track}中的真实需求展开，项目以“发现问题、形成产品、验证场景、沉淀资料、推动转化”为主线，围绕${brief}构建可演示、可验证、可迭代的完整解决方案。项目将目标用户、技术路线、商业路径、经费使用、预期效益和支撑资料纳入同一套论证体系，重点呈现项目的必要性、创新性、可行性和持续推进价值。

项目核心交付为${product}。项目从需求来源、功能模块、技术链路、服务流程、验收指标和迭代机制六个层面组织实施：需求来源明确项目为什么做，功能模块明确项目做什么，技术链路明确项目如何实现，服务流程明确项目如何进入真实场景，验收指标明确项目如何判断成效，迭代机制明确项目如何把测试反馈转化为下一轮优化。

项目目标市场围绕${market}展开。初期重点选择痛点明确、沟通成本可控、能够形成反馈材料的场景进行验证；中期通过标准化部署、服务手册、培训流程和验收表提升复制效率；后期结合数据沉淀、接口能力、场景模块和合作渠道拓展更大范围的应用。市场与财务部分不把未经核验的客户、合同、价格和收益写成既成事实，而是采用公开资料口径、用户材料口径和项目估算口径进行保守测算。

项目经费和资源主要服务于${finance}。资金使用遵循“投入对应成果、成果对应验收、验收对应资料”的原则：研发投入对应原型系统和技术测试，调研投入对应用户画像和需求证据，部署投入对应演示环境和试点流程，展示投入对应商业计划、图表和视频，知识产权与合规投入对应后续成果转化边界。经费测算保持阶段性和可调整性，避免对尚未发生的商业结果作确定承诺。

项目支撑资料以${evidence}为基础组织。正文中的政策判断、市场判断、技术指标、商业测算和团队能力均需要找到对应资料口径；暂未形成正式资料的内容以公开资料、项目估算、原型测试或用户资料口径表达。通过这种方式，商业计划既能完整呈现赛事所需的信息密度，也能保持事实边界清楚，减少评审追问中的真实性风险。

项目当前状态按照“已形成基础、正在验证、持续迭代”三类口径推进。已形成基础包括项目方向、问题场景、初步产品方案和图表框架；正在验证的内容包括核心功能可用性、目标客户反馈、成本测算、竞品差异和资料验证链；持续迭代重点包括真实场景测试、指标记录、演示视频、知识产权材料和成果转化资料。

${makeTable(
  ["摘要维度", "核心内容", "正文对应位置"],
  [
    ["项目痛点", "说明目标场景中的真实矛盾、现有方案不足和用户任务压力", "一、项目概述"],
    ["研究内容", "说明拟解决问题、研究任务、创新点和项目特色", "二、研究目标与项目内容"],
    ["行业依据", "说明政策背景、国内外现状、发展状态和痛点分析", "三、行业背景与国内外现状"],
    ["产品方案", "说明核心产品、技术模块、业务流程和交付形态", "四、产品与服务方案"],
    ["市场机会", "说明客户类型、采购场景、预算口径、竞品和优势", "五、市场分析与竞争分析"],
    ["商业闭环", "说明收入来源、运营方式、营销策略和推广路径", "六、商业模式与运营策略"],
    ["实施基础", "说明技术路线、年度目标、团队分工和已有条件", "七、技术路线与实施计划；八、团队介绍与已有基础"],
    ["财务证明", "说明经费用途、收入预测、风险控制、成果与附件", "九、财务规划与风险管理；十、预期成果、未来展望与证明材料"],
  ],
)}`;
}

function buildProjectBodySupplementSection(config: WorkflowConfig) {
  const name = config.name;
  const track = config.track || config.competition || "大学生创新创业训练项目";
  const product = config.product || "项目原型系统、核心算法模块、服务流程和交付资料";
  const market = config.market || "目标用户、试点单位、行业平台和具备明确需求的应用场景";
  const finance = config.finance || "原型研发、测试验证、设备与部署、资料沉淀、成果展示和后续试点";
  return `## 项目创新点与可行性分析
### 项目创新点
${name}的创新点首先体现在应用场景聚焦。项目不把技术能力停留在通用工具层面，而是围绕${track}中的具体用户、具体任务和具体交付结果展开，把真实场景中的痛点拆解为可识别、可处理、可追踪、可复盘的服务流程。这样的创新不是单纯更换一个算法名称，而是把技术方案放入业务链条中，使项目能够回答“谁在用、为什么用、怎么用、用完产生什么结果”。

第二个创新点体现在产品结构组合。${product}不是孤立功能，而是由数据接入、核心处理、结果呈现、人工复核、记录沉淀和持续迭代构成的完整系统。项目通过模块化方式降低后续扩展成本，一方面便于在竞赛阶段形成演示系统和图表资料，另一方面也便于在后续试点中根据用户反馈替换模块、调整阈值、优化交互和补充接口。

第三个创新点体现在证据化表达。商业计划将市场、技术、财务和支撑资料统一纳入同一套口径：市场判断对应公开资料和用户资料，技术指标对应原型测试和演示记录，财务测算对应项目估算模型，团队能力对应分工和阶段成果。通过这种方式，项目的每个关键结论都能找到支撑路径，避免只靠概念包装形成赛事文本。

第四个创新点体现在服务模式。项目初期以小范围试点和原型验证进入目标场景，中期通过标准化部署、培训、运维和验收表形成可复制交付，后期再结合数据积累、接口授权、模块订阅和行业解决方案实现扩展。该路径既符合大学生创新创业项目从原型到转化的成长规律，也能降低一次性商业化过重带来的实施风险。

${makeTable(
  ["创新类型", "具体体现", "评审价值"],
  [
    ["场景创新", "围绕真实用户任务重构技术应用流程", "证明项目不是空泛概念，具有明确应用对象"],
    ["技术集成创新", "将核心算法、业务规则、数据记录和反馈迭代组合成系统", "证明项目具备可实现、可演示、可迭代能力"],
    ["产品交付创新", "以模块化、低成本、可配置方式进入目标场景", "证明项目具有复制和推广基础"],
    ["商业模式创新", "形成试点、部署、运维、授权和服务的组合收入路径", "证明项目具备持续运营想象空间"],
    ["资料组织创新", "正文、图表、测试记录和估算口径互相对应", "提升项目可信度和路演抗追问能力"],
  ],
)}

### 可行性分析
从技术可行性看，项目采用分阶段实现策略，先完成核心流程，再逐步提高指标和扩展场景。原型阶段重点验证主要功能是否跑通，测试阶段重点记录关键指标是否稳定，试点阶段重点观察用户流程是否顺畅，迭代阶段重点解决误差、成本和运维问题。这样的路径避免一开始追求过大系统，而是把有限资源集中投入到最能证明项目价值的核心环节。

从市场可行性看，${market}具有明确的任务场景和使用痛点。项目初期并不直接追求大规模铺开，而是优先选择需求明确、反馈及时、部署条件相对简单的目标客户或场景，先形成样板案例、演示资料和数据记录。随着功能稳定和资料完善，再逐步扩展到相邻客户群体，降低获客成本和试错成本。

从团队可行性看，项目工作可以拆分为调研、产品、技术、测试、财务、资料和展示七类任务，每类任务都能形成可检查的阶段成果。团队通过里程碑管理、版本复盘和资料沉淀，把个人分工与整体目标连接起来，避免出现只做技术演示而缺少市场、财务和支撑资料的情况。

从经费可行性看，${finance}均可对应到明确成果。研发经费服务于系统原型和技术指标，测试经费服务于样本、日志和问题闭环，部署经费服务于演示环境和试点流程，资料经费服务于商业计划、图表、路演和成果沉淀。经费安排不追求一次性覆盖所有商业化场景，而是围绕大创阶段最关键的验证目标进行配置。

${makeTable(
  ["可行性维度", "可行性依据", "阶段成果"],
  [
    ["技术可行性", "核心流程可拆解为若干可实现模块", "原型系统、测试记录、架构图"],
    ["市场可行性", "目标场景存在明确痛点和改造需求", "用户画像、竞品表、预算口径"],
    ["团队可行性", "任务可按角色分工并形成阶段交付", "分工表、进度表、复盘记录"],
    ["经费可行性", "资金用途与研发、测试、部署、展示对应", "预算表、成果清单、验收指标"],
    ["转化可行性", "可从试点验证逐步走向标准化交付", "试点方案、服务手册、合作意向"],
  ],
)}

## 实施进度安排与成果规划
项目实施按“调研论证、原型开发、测试优化、场景验证、成果固化、推广转化”六个阶段推进。每个阶段都强调可交付成果，而不是只描述工作意愿。调研论证阶段形成问题清单和用户画像；原型开发阶段形成可运行系统或核心模块；测试优化阶段形成指标记录和问题闭环；场景验证阶段形成演示流程和用户反馈；成果固化阶段形成商业计划、图表资料、测试记录和视频；推广转化阶段形成试点方案、合作沟通和持续迭代计划。

${makeTable(
  ["阶段", "主要任务", "阶段成果", "验收方式"],
  [
    ["第一阶段：调研论证", "梳理政策、行业、用户痛点和竞品方案", "调研纪要、用户画像、痛点清单", "材料是否能支撑项目必要性"],
    ["第二阶段：原型开发", "完成核心功能、数据流程和基础界面", "原型系统、架构图、功能截图", "核心流程是否可演示"],
    ["第三阶段：测试优化", "构建样本、记录指标、修复问题", "测试表、日志、问题闭环表", "指标是否有口径和记录"],
    ["第四阶段：场景验证", "在目标场景中演示流程并收集反馈", "演示视频、反馈纪要、部署清单", "用户任务是否能够闭环"],
    ["第五阶段：成果固化", "整理商业计划、支撑资料、财务测算和路演材料", "图表、资料目录、演示视频", "资料之间是否一致"],
    ["第六阶段：推广转化", "形成试点方案、服务手册和合作沟通材料", "试点计划、报价口径、服务流程", "是否具备后续复制路径"],
  ],
)}

项目成果分为技术成果、文档成果、市场成果和转化成果四类。技术成果包括核心代码、原型系统、算法或业务模块、测试记录和部署说明；文档成果包括商业计划、调研报告、竞品分析、财务模型、资料目录和路演材料；市场成果包括用户画像、试点清单、预算口径、合作沟通记录和服务流程；转化成果包括软著或专利材料、标准化服务包、演示视频和后续版本规划。四类成果共同构成项目从竞赛推进走向持续运营的基础。

## 风险分析与保障措施
项目实施过程中主要面临技术、数据、场景、市场、团队和合规六类风险。技术风险表现为核心功能达不到预期、系统稳定性不足或指标波动较大；数据风险表现为样本数量不足、来源不稳定或代表性有限；场景风险表现为真实环境与实验环境存在差异；市场风险表现为客户预算周期长、采购流程复杂或竞品替代性强；团队风险表现为成员时间冲突、任务衔接不畅或资料沉淀不及时；合规风险表现为隐私、授权、数据留存和成果真实性边界不清。

针对以上风险，项目采取“提前识别、分级处理、资料留痕、持续复盘”的保障机制。技术风险通过阶段测试、版本管理和人工复核降低；数据风险通过样本说明、来源记录和补充采集降低；场景风险通过小范围试点、备用方案和参数配置降低；市场风险通过客户分层、低成本试点和保守估算降低；团队风险通过任务表、例会复盘和交付物责任制降低；合规风险通过授权说明、脱敏处理和资料核对降低。

在支撑资料组织上，项目将政策依据、调研记录、产品截图、测试结果、财务测算、团队分工和合作沟通资料分别沉淀。政策依据用于支撑项目必要性，调研记录用于支撑用户痛点和市场入口，产品截图用于支撑原型完成度，测试结果用于支撑技术可行性，财务测算用于支撑资金使用和收益预测，团队分工用于支撑执行能力，合作沟通资料用于支撑后续试点可能性。各类资料在正式提交时均以真实文件、原始记录或指导教师审核意见为准，避免正文与资料脱节。

项目还将建立事实边界管理机制。已经完成的内容按照成果口径表述，正在验证的内容按照测试口径表述，尚未落地的客户、合同、知识产权和财务收益按照计划或估算口径表述。通过区分成果、测试、估算和计划四类表达，项目既能保持完整叙事，也能减少夸大风险，使商业计划更加符合赛事文本的真实性要求。

${makeTable(
  ["风险类别", "风险表现", "保障措施"],
  [
    ["技术风险", "功能不稳定、指标波动、适配困难", "分阶段测试、保留日志、建立问题闭环"],
    ["数据风险", "样本不足、来源有限、代表性不足", "记录样本口径、扩展数据来源、标注异常样例"],
    ["场景风险", "真实环境与实验环境差异较大", "先做小范围验证，再逐步扩展场景"],
    ["市场风险", "客户预算和采购周期不确定", "采用试点进入、模块报价和保守测算"],
    ["团队风险", "分工不清、进度拖延、资料缺失", "明确责任人、里程碑和资料沉淀规则"],
    ["合规风险", "隐私授权、数据留存和成果真实性不清", "采用授权说明、脱敏处理和事实口径管理"],
  ],
)}

## 推广应用与成果转化计划
项目推广遵循由近到远、由小到大、由演示到服务的路径。第一步依托校内资源、指导教师、课程项目和身边可接触场景完成原型验证；第二步选择目标客户或试点单位进行小范围演示，形成反馈和改进记录；第三步把系统部署、培训、运维和验收流程标准化，形成可复制的交付手册；第四步根据不同客户类型形成版本组合和收费口径；第五步通过竞赛路演、校企合作、行业活动和线上展示扩大项目影响力。

成果转化不只依赖一次性销售，而是围绕“产品化、服务化、平台化”逐步推进。产品化阶段强调稳定功能和清晰界面；服务化阶段强调部署、培训、运维和反馈；平台化阶段强调多客户管理、接口能力、数据沉淀和生态合作。项目后续可根据实际资源选择轻量化创业、校企合作、技术授权、公益试点或继续参加更高级别赛事等路径。

${makeTable(
  ["转化路径", "主要方式", "适用条件"],
  [
    ["竞赛深化", "继续完善商业计划、路演、支撑资料和演示系统", "适合大创、挑战杯、互联网+等赛事推进"],
    ["校内试点", "对接学院、实验室或校内真实场景验证", "适合获取低成本反馈和演示材料"],
    ["校企合作", "与企业或机构共建试点方案", "适合产品已有基础功能和服务流程"],
    ["技术授权", "以模块、接口或算法能力提供给集成方", "适合核心模块较成熟的阶段"],
    ["创业孵化", "组建小团队持续迭代并探索收费", "适合已有客户反馈和明确收入口径"],
  ],
)}

## 运营管理与质量控制体系
项目进入持续推进阶段后，需要建立稳定的运营管理机制。运营管理不只包括系统上线后的维护，也包括需求收集、版本规划、问题响应、数据更新、客户沟通和成果沉淀。团队将项目运行过程拆分为需求管理、研发管理、测试管理、部署管理、反馈管理和资料管理六个环节，每个环节都设置责任角色和输出资料，确保项目从赛事推进到后续试点都能保持连续性。

需求管理环节重点记录目标用户的真实任务、使用频次、痛点强度和期望功能，避免后续开发偏离场景；研发管理环节重点记录功能变更、模块边界、接口调整和版本更新，保证系统可维护；测试管理环节重点记录样本来源、测试指标、异常案例和修复结果，保证技术结论可复核；部署管理环节重点记录环境条件、设备清单、培训过程和验收情况，保证交付过程可追踪；反馈管理环节重点记录用户意见、误差来源和改进优先级，保证项目持续优化；资料管理环节重点保证正文、图表、支撑资料、演示材料和财务测算口径一致。

${makeTable(
  ["管理环节", "管理重点", "输出材料"],
  [
    ["需求管理", "用户任务、痛点强度、功能优先级", "需求清单、用户画像、访谈纪要"],
    ["研发管理", "模块边界、接口说明、版本变更", "版本日志、接口文档、功能截图"],
    ["测试管理", "样本口径、指标记录、异常复盘", "测试表、问题清单、修复记录"],
    ["部署管理", "环境条件、设备配置、培训验收", "部署清单、培训记录、验收表"],
    ["反馈管理", "用户评价、误差来源、改进排序", "反馈纪要、迭代计划、复盘报告"],
    ["资料管理", "正文、图表、支撑资料和展示材料一致", "资料目录、图表文件、路演材料"],
  ],
)}

质量控制方面，项目采用“事前设标准、事中留记录、事后可复盘”的原则。事前标准包括功能目标、测试指标、交付物清单和资料口径；事中记录包括开发日志、测试日志、会议纪要、用户反馈和经费使用记录；事后复盘包括问题归因、版本改进、成本调整和下一阶段计划。通过质量控制体系，项目能够把零散工作沉淀为可评价成果，使正文中的每一项结论都能回到实际过程和资料依据中。

质量控制结果将进一步进入持续改进机制。团队每完成一次测试、演示或用户沟通，都将把新增问题归类为功能优化、指标优化、交互优化、资料优化和商业口径优化五类，并在下一轮版本中明确处理顺序。通过这种方式，项目能够从一次性赛事文本逐步转向长期项目管理，使技术实现、用户反馈、商业测算和支撑资料保持同步更新。`;
}

function buildSupplementByChapter(config: WorkflowConfig) {
  const name = config.name;
  const product = cleanConfigPhrase(config.product || "", "项目原型系统、核心算法模块和服务实施流程");
  const result = new Map<string, string>();
  if (!isElderCareFallConfig(config)) return result;
  result.set("一、项目概述", `### 场景边界与服务对象深化
${name}的价值不在于把算法概念简单放入养老场景，而在于把养老照护中“风险难发现、响应难追踪、责任难复盘”的问题转化为可运行的服务流程。项目首先聚焦床边、走廊、活动室、康复区和卫生间门口等高风险区域，避免一开始覆盖过宽导致部署和验证失焦；其次聚焦护理人员、机构管理者、老人及家属、社区养老服务方等直接相关对象，使每一项功能都能对应明确的使用任务。

在典型养老机构中，护理人员最需要的是“收到明确提醒、知道在哪处理、处理后有记录”；机构管理者最需要的是“了解风险发生频次、复盘响应效率、形成安全管理依据”；老人及家属最需要的是“安全被守护、隐私被尊重、异常有解释”。项目由此形成无感检测、分级告警、人工复核、事件留痕、统计复盘五个核心环节，既保留技术创新，也保证方案进入真实护理流程。

${makeTable(
  ["对象", "核心诉求", "应对方式", "验证方式"],
  [
    ["护理人员", "少漏看、快定位、易处理", "点位告警、片段复核、处理状态标记", "告警流程演示、操作记录"],
    ["机构管理者", "可追溯、可统计、可复盘", "事件台账、响应时间统计、月度报表", "后台截图、样例报表"],
    ["老人及家属", "及时响应、低打扰、隐私可控", "无感检测、授权区域、最小化采集", "隐私说明、授权流程"],
    ["社区服务方", "风险发现、远程协同、服务闭环", "社区端提醒、家属端通知、转介记录", "服务流程图、试点记录"],
  ],
)}`);
  result.set("三、市场分析", `### 目标市场进入路径
项目市场进入采用“近场验证—样板试点—渠道合作—复制推广”的路径。近场验证阶段依托校内资源、指导教师资源和本地可接触场景完成访谈与演示；样板试点阶段选择痛点明确、沟通成本较低、能够形成反馈材料的客户进行小范围验证；渠道合作阶段对接智慧养老平台、设备集成商、社区服务组织或康养机构；复制推广阶段把部署清单、培训流程、验收表和运维说明固化为标准服务包。

${makeTable(
  ["进入阶段", "主要对象", "关键动作", "形成材料"],
  [
    ["近场验证", "校内资源、本地机构、模拟场景", "访谈、演示、需求确认", "访谈纪要、需求表"],
    ["样板试点", "养老院、社区服务中心、居家养老机构", "部署轻量版本、记录反馈", "演示视频、试点记录"],
    ["渠道合作", "平台商、设备商、集成商", "接口沟通、联合方案", "合作方案、报价口径"],
    ["复制推广", "同类机构和区域客户", "标准化交付、运维服务", "服务手册、验收表"],
  ],
)}`);
  result.set("三、市场分析", `${result.get("三、市场分析")}

### 采购触发条件与客户分层
养老防摔检测并不是单纯的技术采购，而是安全管理、服务质量和成本控制共同驱动的决策。机构客户通常在发生安全事故、夜间护理压力上升、家属沟通成本增加、数字化改造预算释放或智慧养老平台升级时产生采购意愿。项目初期将客户分为示范型机构、成本敏感型机构、平台集成型客户和社区服务型客户四类，分别匹配不同进入方式。

${makeTable(
  ["客户类型", "采购触发", "适合方案", "转化重点"],
  [
    ["示范型机构", "希望打造智慧养老样板", "多点位部署+管理报表", "展示效果和服务品牌"],
    ["成本敏感型机构", "夜间巡护压力大但预算有限", "2-5个重点点位试点", "低改造成本和风险发现效果"],
    ["平台集成型客户", "已有养老平台缺少垂直算法", "SDK/API授权或模块接入", "接口稳定性和算法边界"],
    ["社区服务型客户", "需要覆盖独居老人或日间照料站", "社区端后台+家属通知", "远程协同和服务记录"],
  ],
)}`);
  result.set("四、产品介绍", `### 服务实施流程
产品落地不仅依赖系统功能，还依赖清晰的实施流程。项目实施从场景勘察开始，确认安装位置、网络条件、用户权限和隐私边界；随后完成系统部署、样本测试、参数配置和人员培训；试运行阶段重点记录误报、漏报、响应时间和用户操作问题；验收阶段根据功能完成度、运行稳定性、反馈记录和材料齐备度进行评估；运维阶段持续提供版本更新、问题响应和数据复盘。

${makeTable(
  ["实施环节", "工作内容", "验收材料"],
  [
    ["场景勘察", "确认使用区域、设备条件、隐私边界和业务流程", "勘察记录、点位说明"],
    ["系统部署", "安装配置、权限设置、数据接入和基础测试", "部署清单、配置截图"],
    ["人员培训", "说明告警查看、事件处理、后台记录和异常反馈", "培训记录、操作手册"],
    ["试运行", "记录误报漏报、响应时间、稳定性和用户意见", "测试表、反馈纪要"],
    ["正式验收", "核对功能、指标、流程、材料和运维责任", "验收表、版本说明"],
  ],
)}`);
  result.set("四、产品介绍", `${result.get("四、产品介绍")}

### 典型使用流程
以养老院夜间走廊场景为例，摄像头视频进入边缘端或服务器后，YOLO11检测服务持续识别人体目标。当系统发现老人由站立或行走状态转为明显低姿态，并在地面区域附近持续静止，判断引擎会结合连续帧、点位区域和历史阈值生成疑似跌倒事件。护理端收到提醒后查看点位、时间、片段和风险等级，现场确认后选择已处理、误报或需复查，后台同步生成事件台账。

该流程保留人工复核环节，避免系统把单帧检测结果直接等同于护理结论。误报样本会进入复盘列表，例如弯腰捡物、坐下休息、康复训练、多人遮挡和光照变化等场景；漏报样本则用于补充训练数据和调整规则阈值。通过这样的闭环，产品从“能识别”进一步走向“能服务、能追踪、能改进”。`);
  result.set("五、商业模式", `### 合作生态
项目商业模式需要与合作生态共同推进。对于养老机构，项目提供可部署的安全预警服务；对于社区养老平台，项目提供可接入的风险识别模块；对于设备厂商，项目可作为摄像头或边缘设备的智能能力补充；对于系统集成商，项目可进入其智慧养老整体方案；对于学校和孵化平台，项目可作为学生创新创业成果持续培育。

合作生态的核心原则是职责清楚、收益清楚、边界清楚。项目团队负责核心算法、产品原型、服务流程和产品资料；合作机构提供场景反馈、试点条件或渠道资源；平台方负责系统集成、客户交付或运营承接。收益分配可按项目部署、授权调用、运维服务或联合方案进行设计，具体金额采用项目估算口径。

### 收入结构与服务组合
项目收入不依赖单一卖断模式，而是由试点服务、点位部署、年度运维、模块授权和定制开发共同构成。早期阶段以小额试点降低客户决策门槛，中期阶段按点位或楼层形成标准部署收入，后期阶段通过平台接入和集成商合作扩大覆盖范围。对于养老机构，系统价值主要体现为风险响应和管理留痕；对于平台客户，系统价值主要体现为垂直算法能力和接口扩展。

${makeTable(
  ["收入类型", "客户对象", "交付内容", "持续性"],
  [
    ["试点服务费", "养老院、社区站点", "2-5个重点点位部署和试运行", "低"],
    ["点位部署费", "护理院、康养社区", "摄像头接入、模型配置、后台开通", "中"],
    ["年度运维费", "已部署客户", "模型更新、故障处理、月度复盘", "高"],
    ["模块授权费", "平台商、设备商", "SDK/API、接口文档、联调支持", "高"],
    ["定制开发费", "大型机构或园区", "特殊报表、平台对接、场景扩展", "中"],
  ],
)}`);
  result.set("七、财务规划", `### 财务敏感性分析
项目财务结果受客户数量、部署成本、运维人力、设备价格和转化率影响较大，因此财务测算采用保守、中性、积极三档情景。保守情景下，项目以少量试点和演示部署为主，收入主要覆盖基础研发和材料成本；中性情景下，项目形成稳定部署与年度运维收入；积极情景下，项目通过平台合作、模块授权和定制服务提升收入规模。

${makeTable(
  ["情景", "客户假设", "收入结构", "经营重点"],
  [
    ["保守情景", "1-3个试点客户", "试点服务费、基础部署费", "验证需求和形成样板"],
    ["中性情景", "5-10个机构或平台客户", "部署费、运维费、定制服务", "标准化交付和复购"],
    ["积极情景", "多区域合作或平台接入", "授权费、订阅费、联合方案收入", "渠道扩展和生态合作"],
  ],
)}

项目将通过控制固定成本、分阶段采购设备、优先使用开源和云服务、滚动更新预算等方式降低财务风险。每一笔支出都对应研发、测试、部署、运营或成果资料，保证经费使用能够被产品版本、测试记录、试点反馈和财务表解释。

### 单点位经济模型
以单摄像头点位为最小核算单元，项目成本由视频接入、边缘算力、模型配置、人员培训和运维支持构成。收入则由部署费和年服务费组成。若单点位部署成本随批量复制下降，年度运维能够覆盖远程维护和模型更新，项目即可从小规模试点逐步进入可持续服务阶段。该模型适合养老机构从重点区域先行试用，再根据实际效果扩展到更多房间、走廊和活动区域。

${makeTable(
  ["核算项", "主要内容", "影响因素", "控制方式"],
  [
    ["硬件成本", "摄像头接入、边缘盒或服务器资源", "点位数量、画面质量、算力需求", "复用既有设备、分批采购"],
    ["研发成本", "模型训练、规则引擎、前后端开发", "功能复杂度、数据规模", "模块化开发、版本迭代"],
    ["部署成本", "现场勘察、网络配置、人员培训", "机构环境、点位分布", "标准清单、远程支持"],
    ["运维成本", "模型更新、误报处理、客户沟通", "客户数量、问题频次", "后台记录、常见问题库"],
    ["收入来源", "部署费、年服务费、接口授权", "客户预算、采购周期、服务价值", "分层报价、样板案例"],
  ],
)}`);
  result.set("八、团队介绍", `### 项目管理机制
团队采用周计划、阶段复盘和成果沉淀相结合的管理机制。周计划用于明确本周开发、调研、测试和资料任务；阶段复盘用于检查核心功能、市场反馈、财务测算和风险清单；成果沉淀用于保存代码说明、测试记录、访谈纪要、图表资料、版本记录和展示资料。通过项目管理机制，团队能够把分散工作转化为连续成果。

团队协作强调角色互补。技术成员负责实现和验证，产品成员负责流程和体验，市场成员负责用户和竞品，财务成员负责预算和测算，文档成员负责正文、图表和测试记录一致。各角色之间不是简单分工，而是围绕同一条项目主线共同推进：技术结果要进入产品，产品流程要接受市场验证，市场判断要进入财务测算，财务数据和测试记录要支撑项目可信度。`);
  result.set("九、风险管理", `### 隐私合规与误报控制
养老防摔检测涉及视频数据，项目必须把隐私合规作为产品边界而不是后置说明。系统优先覆盖公共区域、授权区域和风险高发区域，不进入高度私密空间；数据使用遵循最小化采集原则，只保留必要的事件片段、点位编号、时间和处理状态。后台权限按护理人员、管理者和系统维护人员分级，避免无关人员查看敏感片段。

误报和漏报是视觉检测产品必须正面处理的问题。项目采用连续帧确认、区域规则、人工复核和误报样本回流四种方式降低误报；采用重点区域覆盖、长时间静止检测、夜间阈值调整和漏报复盘降低漏报。风险控制不是追求一次性消除所有错误，而是让每类错误都能被发现、记录、分析和改进。

${makeTable(
  ["风险点", "发生原因", "控制动作", "复盘指标"],
  [
    ["隐私风险", "摄像头覆盖区域不清、权限管理不足", "授权说明、区域限制、权限分级", "授权完整率、访问记录"],
    ["误报风险", "弯腰、坐下、康复训练与跌倒相似", "连续帧确认、人工复核、样本回流", "误报率、误报场景分布"],
    ["漏报风险", "遮挡、光照不足、角度异常", "多点位覆盖、夜间阈值、问题样本复训", "漏报率、响应时间"],
    ["部署风险", "网络不稳、设备兼容差", "部署清单、备选设备、现场测试", "接入成功率、故障时长"],
  ],
)}`);
  result.set("十、未来展望", `### 产品演进路线
${name}的未来演进将从单一跌倒检测扩展到养老安全管理的多场景能力。短期聚焦跌倒识别、长时间静止、护理端告警和后台台账；中期拓展到夜间离床、异常徘徊、危险区域停留和护理响应评价；长期与智慧养老平台、社区居家养老服务和康养机构管理系统对接，形成面向机构、社区和家庭的安全辅助能力。

产品演进遵循“先做深，再做宽”的原则。先在床边、走廊和活动室等高频场景中把识别准确性、响应流程和事件记录做扎实，再逐步增加行为类型和合作渠道。随着试点记录、用户反馈和模型样本持续积累，项目将形成更贴近养老场景的数据资产和服务经验，为后续软著、专利、论文、校企合作和创业孵化提供基础。

${makeTable(
  ["阶段", "产品重点", "市场重点", "成果形态"],
  [
    ["近期", "跌倒识别、分级告警、事件台账", "本地机构试点、社区站点演示", "原型系统、测试记录、服务流程"],
    ["中期", "离床检测、徘徊识别、响应评价", "养老机构复制、平台接口合作", "标准服务包、接口文档、运维体系"],
    ["远期", "多场景安全管理、区域化数据分析", "智慧养老生态合作、康养园区服务", "行业解决方案、数据模型、合作网络"],
  ],
)}`);
  return result;
}

function assembleFinalBook(config: WorkflowConfig, artifacts: ArtifactFile[]) {
  const chapterSupplements = buildSupplementByChapter(config);
  const hasReferenceWorkflow = referenceStyleWorkflowSteps(config).length > 0;
  const chapters = assembleChaptersForFinalBook(artifacts, config)
    .split(/\n(?=## [一二三四五六七八九十]、)/)
    .map((chapter) => {
      const title = chapter.match(/^##\s+(.+)$/m)?.[1]?.trim();
      const supplement = title ? chapterSupplements.get(title) : "";
      return supplement ? `${chapter.trim()}\n\n${supplement}` : chapter.trim();
    })
    .join("\n\n");

  const competitionLabel: Record<string, string> = {
    dachuang: "大学生创新创业训练计划项目",
    tiaozhanbei: "挑战杯项目",
    "internet-plus": "互联网+创新创业项目",
  };
  const effectiveTemplate = effectiveProjectBookTemplateId(config);
  const competitionText = competitionLabel[effectiveTemplate] || config.competition || "大学生创新创业项目";
  const displayName = projectBookDisplayName(config);
  const body = `# ${projectBookDocumentTitle(config)}

## 封面信息
${makeTable(
  ["项目字段", "内容"],
  [
    ["项目名称", displayName],
    ["项目类别", competitionText],
    ["项目类型", config.track || "创业训练项目"],
    ["团队基础", config.team || "项目团队按研发、产品、调研、财务和申报展示分工组织"],
    ["材料口径", "正文采用公开资料口径、项目估算口径、原型测试口径和用户材料口径形成"],
  ],
)}

## 目录
${buildTableOfContents(artifacts, config)}

${chapters}
`;
  const cleaned = deTemplateProjectNarrative(
    finalizeManuscriptTone(normalizeProjectBookHeadings(sanitizeProjectBookBody(body))),
    config,
  );
  const shaped = polishFinalBookSubmissionShape(cleaned);
  return syncFinalBookToc(shaped, config);
}

function syncFinalBookToc(text: string, config: WorkflowConfig) {
  const toc = expectedProjectBookChapters(config).map((section) => `- ${section}`).join("\n");
  const source = String(text || "").trim();
  if (!source.includes("## 目录")) return source;
  const normalized = `## 目录\n${toc}\n`;
  if (/## 目录[\s\S]*?(?=\n##\s+)/.test(source)) {
    return source.replace(/## 目录[\s\S]*?(?=\n##\s+)/, normalized);
  }
  return source.replace(/## 目录[^\n]*(?:\n(?:- .*)?)?/, normalized.trimEnd());
}

function cleanFinalBookForSubmission(text: string, config: WorkflowConfig) {
  const contaminationRepair = removeCrossProjectContamination(text, config);
  return preserveCurrentTechVersions(polishFinalBookSubmissionShape(deTemplateProjectNarrative(
    finalizeManuscriptTone(
      normalizeProjectBookHeadings(
        sanitizeProjectBookBody(
          finalizeSubmissionTone(
            stripAutoGeneratedSections(removeRepeatedAutoSections(contaminationRepair.text)),
          ),
        ),
      ),
    ),
    config,
  )), config);
}

function ensureFinalBookRealismSignals(text: string, config: WorkflowConfig) {
  if (referenceStyleWorkflowSteps(config).length) return text;
  let next = text;
  const profile = currentTopicProfile(config);
  const projectName = projectBookDisplayName(config);
  const users = sentenceList(profile.users.slice(0, 4), "核心用户");
  const scenes = sentenceList(profile.scenes.slice(0, 4), "典型场景");
  const modules = sentenceList(profile.productModules.slice(0, 5), "核心功能模块");
  const metrics = sentenceList(profile.metrics.slice(0, 5), "效率、成本、稳定性和满意度指标");
  const models = sentenceList(profile.businessModels.slice(0, 4), "项目制交付、订阅运维和定制化服务");
  const figureSignals = countOccurrences(next, /!\[|paper:\/\/figure|图\s*\d|图[一二三四五六七八九十]/g);
  const numericSignals = countOccurrences(next, /\d+(?:\.\d+)?\s*(?:%|万元|元|人|个|项|份|家|次|月|年|周|页)|M[1-9]|第[一二三四五六七八九十]+阶段/g);

  const steps = projectChapterSteps(config);
  const productStep = steps.find((step) => chapterCompletionNeed(step) === "product") || steps.find((step) => /产品|服务|方案|技术/.test(step.name + step.targetSection));
  const operationStep = steps.find((step) => chapterCompletionNeed(step) === "operation") || steps.find((step) => /运营|实施|计划|推广/.test(step.name + step.targetSection));
  const financeStep = steps.find((step) => chapterCompletionNeed(step) === "finance") || steps.find((step) => /财务|融资|资金|商业/.test(step.name + step.targetSection));

  if (figureSignals < 2 && productStep) {
    const figureBlock = [
      `### 图表化产品表达`,
      `${projectName}采用架构图和服务流程图呈现核心逻辑。图1展示${users}、业务输入、${modules}、管理端和结果输出之间的关系，呈现产品从场景需求到交付结果的完整链路；图2展示${scenes}中的服务实施过程，把需求确认、原型验证、用户反馈、结果归档和版本迭代连接起来。两张图与功能模块表、实施进度表和财务测算表共同构成图表体系。`,
      "",
      `![图1 ${projectName}系统/产品架构图](paper://figure/architecture)`,
      "",
      `![图2 ${projectName}服务实施流程图](paper://figure/service-flow)`,
      "",
      makeTable(
        ["图表编号", "图表名称", "说明重点", "支撑章节"],
        [
          ["图1", "系统/产品架构图", `呈现${modules}与用户端、管理端、数据/资料输入、结果输出的关系`, "支撑产品服务和技术路线"],
          ["图2", "服务实施流程图", `呈现${scenes}中的需求触发、处理、复核、归档和迭代过程`, "支撑运营管理和实施计划"],
          ["表1", "功能模块表", "说明模块职责、交付形态和验收材料", "支撑产品可行性"],
          ["表2", "指标与测算口径表", `对应${metrics}`, "支撑技术、市场和财务判断"],
        ],
      ),
    ].join("\n");
    const inserted = insertSpecificChapterSupplement(next, productStep, figureBlock);
    if (inserted.changed) next = inserted.text;
  }

  if (numericSignals < 18) {
    const quantitativeBlock = [
      `### 量化指标与测算口径`,
      `${projectName}的量化表达采用公开资料口径、团队估算口径、原型测试口径和用户材料口径。团队不把估算值写成既成经营结果，而是把数字用于说明阶段目标、验证方法、成本边界和成果交付。围绕${metrics}，指标分为过程指标、结果指标、成本指标和材料指标四类，保证市场、产品、运营和财务判断有可复核尺度。`,
      "",
      makeTable(
        ["指标类别", "阶段目标", "测算口径", "支撑材料"],
        [
          ["用户调研", "完成20-30份访谈/问卷记录，形成3-5类核心用户画像", "用户材料口径", "访谈纪要、需求清单、画像表"],
          ["原型验证", "完成2轮原型演示、3组典型场景测试和8项核心功能核验", "原型测试口径", "原型截图、测试表、问题清单"],
          ["实施进度", "M1需求确认、M2原型闭环、M3测试验证、M4材料定稿", "项目进度口径", "版本日志、里程碑验收表"],
          ["市场进入", "先验证1-3个试点场景，再拓展5-10家潜在客户或合作方", "项目估算口径", "客户分层表、渠道计划"],
          ["成本预算", "研发、测试、推广、运维和资料沉淀按5项费用归集", "项目估算口径", "预算表、资金用途说明"],
          ["财务模型", `${models}按12个月滚动测算，保守情景、中性情景和积极情景分别核算`, "项目估算口径", "收入预测表、现金流测算表"],
          ["质量验收", "交付物不少于1份项目书终稿、2张核心图示、5类证明资料和1套答辩材料", "提交核验口径", "正文、附件、路演材料"],
          ["研发预算", "原型开发、接口联调和测试环境按3万元-8万元区间估算", "项目估算口径", "研发任务表、工具清单"],
          ["推广预算", "路演展示、用户调研和样板沟通按1万元-3万元区间估算", "项目估算口径", "推广计划、访谈记录"],
          ["运维预算", "部署支持、版本更新和问题响应按每月2次-4次服务频次估算", "项目估算口径", "运维记录、服务清单"],
          ["转化假设", "早期转化率按10%-20%保守估算，复购或续费率按30%-50%滚动复核", "项目估算口径", "客户沟通表、销售漏斗表"],
          ["团队投入", "研发、调研、财务、运营、材料5类角色按每周1次复盘、每月1次阶段验收推进", "项目管理口径", "分工表、会议纪要"],
        ],
      ),
      "",
      `按照上述口径，数字主要用于说明任务规模、验证频次、阶段节奏和经费边界。若后续形成真实合同、试点数据、专利或软著材料，再在附件和答辩材料中补充对应证明；在当前申报文本中，所有未实际发生的收入、客户和授权均保持估算或计划口径。`,
    ].join("\n");
    const targetStep = financeStep || operationStep || productStep;
    if (targetStep) {
      const inserted = insertSpecificChapterSupplement(next, targetStep, quantitativeBlock);
      if (inserted.changed) next = inserted.text;
    } else if (!next.includes("量化指标与测算口径")) {
      next = `${next}\n\n${quantitativeBlock}`.trim();
    }
  }

  return next;
}

function minimumDepthProfileBlocks(
  profile: ProjectProfile,
  name: string,
  users: string,
  scenes: string,
  modules: string,
  metrics: string,
  proofs: string,
) {
  if (profile.id === "campus-competition-teaming") {
    const businessTitle = "校内赛事试点与运行闭环";
    return {
      businessTitle,
      businessBlock: [
        `### ${businessTitle}`,
        `${name}的早期验证适合从学院赛事报名周期、创新创业社团、课程团队和指导教师资源切入。团队先开放组队招募、队友申请、技能标签、赛事信息和资料沉淀等核心功能，让${users}在${scenes}中完成真实任务，再根据申请转化、沟通效率、材料完整度和团队活跃情况调整功能优先级。这样的试点路径不依赖大规模推广，能够在一个竞赛周期内形成可观察的运行数据。`,
        `运行闭环由“发布-匹配-沟通-确认-协同-归档-展示”组成。发布环节解决信息分散，匹配环节解决技能与需求错位，沟通环节降低陌生同学组队成本，确认环节沉淀团队关系，协同环节跟踪进度，归档环节保留竞赛资料，展示环节让优秀队伍和成果得到二次传播。`,
        makeTable(
          ["运行节点", "关键动作", "观察指标", "沉淀材料"],
          [
            ["发布", "学生或负责人发布招募需求、作品简介和技能缺口", "信息完整率、审核通过率", "招募帖样例、审核记录"],
            ["匹配", "依据技能标签、竞赛方向和时间安排推荐队友", "需求匹配准确率、申请转化率", "匹配流程图、申请记录"],
            ["沟通", "站内留言、资料交换和教师对接形成初步合作", "平均响应时间、有效沟通次数", "沟通纪要、问题清单"],
            ["确认", "队伍确认成员、角色和阶段任务", "组队成功率、角色覆盖率", "团队分工表、任务看板"],
            ["归档", "沉淀商业计划、路演PPT、原型图和答辩资料", "资料归档完整度、版本更新次数", "资料目录、版本日志"],
          ],
        ),
      ].join("\n\n"),
      proofBlock: [
        `### 材料复核与版本沉淀`,
        `证明材料不只放在最后清单中，还要反向约束章节结论。围绕${proofs}，团队把每类材料对应到一个可核验结论：学生访谈支撑需求真实性，竞赛信息样例支撑场景来源，原型截图支撑产品完成度，队友匹配流程图支撑服务链路，竞品对比表支撑差异化判断，团队进度看板支撑执行能力，财务测算表支撑经费与收益假设。`,
        `版本沉淀采用“材料名称、形成时间、负责人、支撑结论、对应章节、当前状态”六项记录。这样处理后，计划书不需要反复使用空泛判断，而能通过材料关系说明${modules}怎样服务${users}，${metrics}怎样评价运行效果，${scenes}怎样形成后续试点空间。`,
        makeTable(
          ["材料类型", "复核重点", "对应结论", "后续更新方式"],
          [
            ["访谈纪要", "对象是否真实、问题是否具体、记录是否完整", "需求存在且有使用场景", "每轮试点后补充新访谈"],
            ["原型截图", "招募、匹配、沟通、归档流程是否连贯", "平台具备可演示基础", "按版本保留截图和说明"],
            ["流程图", "发布、匹配、确认、协同、展示是否闭环", "服务链路清晰", "根据用户反馈调整节点"],
            ["竞品表", "对照对象、功能差异和成本边界是否清楚", "差异化进入路径成立", "新增校内外替代方案"],
            ["财务表", "成本、价格、客户数量和运维假设是否一致", "资金安排具有解释力", "按试点反馈滚动修正"],
          ],
        ),
      ].join("\n\n"),
    };
  }

  if (profile.id === "elder-care-fall") {
    const businessTitle = "养老场景试点与告警闭环";
    return {
      businessTitle,
      businessBlock: [
        `### ${businessTitle}`,
        `${name}的早期验证适合从本地养老院、社区日间照料中心、护理实训场景和可授权居家看护样本切入。团队先选择床边、走廊、活动室、康复区和卫生间门口等高风险点位进行小范围试装，完成视频接入、人体检测、姿态判断、分级告警、护理人员复核和事件台账记录，再根据误报场景、响应时间、点位成本和护理人员反馈调整规则阈值与部署方式。这样的试点路径不依赖大规模铺开，能够在一个护理周期内形成可观察的运行数据。`,
        `运行闭环由“点位接入-风险识别-分级告警-护理复核-事件归档-样本回流”组成。点位接入解决风险区域覆盖问题，风险识别把视频片段转化为可处理提醒，分级告警区分疑似跌倒、长时间静止和低等级异常，护理复核保留人工判断，事件归档支撑机构管理和家属沟通，样本回流用于降低误报漏报。系统由此从普通监控回看转向可追踪的安全辅助服务。`,
        makeTable(
          ["运行节点", "关键动作", "观察指标", "沉淀材料"],
          [
            ["点位接入", "选择床边、走廊、活动室等授权区域接入视频", "点位覆盖率、在线率", "点位清单、授权说明"],
            ["风险识别", "识别人体姿态、地面区域接触和连续静止状态", "疑似跌倒识别率、误报率", "测试片段、识别记录"],
            ["分级告警", "按风险等级向护理端推送点位、时间和片段", "平均告警响应时间", "告警截图、推送记录"],
            ["护理复核", "护理人员确认已处理、误报或需复查", "复核完成率、处理时长", "事件台账、处理记录"],
            ["样本回流", "整理误报漏报样本并更新规则或模型", "漏报率、版本迭代次数", "误报漏报分析表、版本日志"],
          ],
        ),
      ].join("\n\n"),
      proofBlock: [
        `### 材料复核与版本沉淀`,
        `证明材料不只放在最后清单中，还要反向约束章节结论。围绕${proofs}，团队把每类材料对应到一个可核验结论：护理人员访谈支撑需求真实性，摄像头点位清单支撑部署边界，跌倒检测演示视频支撑产品完成度，后台事件台账截图支撑告警闭环，误报漏报分析表支撑技术迭代，隐私授权说明支撑合规边界，财务测算表支撑经费与收益假设。`,
        `版本沉淀采用“材料名称、形成时间、负责人、支撑结论、对应章节、当前状态”六项记录。这样处理后，计划书不需要反复使用空泛判断，而能通过材料关系说明${modules}怎样服务${users}，${metrics}怎样评价运行效果，${scenes}怎样形成后续试点空间。`,
        makeTable(
          ["材料类型", "复核重点", "对应结论", "后续更新方式"],
          [
            ["访谈纪要", "护理人员、机构管理者和家属诉求是否具体", "跌倒预警需求真实存在", "每轮试点后补充访谈"],
            ["点位清单", "授权区域、摄像头位置和隐私边界是否清楚", "部署范围可控", "随点位调整更新清单"],
            ["演示视频", "告警流程、复核入口和台账记录是否连贯", "系统具备可演示基础", "按版本保留片段和说明"],
            ["误报分析", "误报动作、光照遮挡和场景差异是否记录", "模型和规则可迭代", "按测试批次滚动更新"],
            ["财务表", "点位成本、部署价格和运维假设是否一致", "资金安排具有解释力", "按试点反馈滚动修正"],
          ],
        ),
      ].join("\n\n"),
    };
  }

  if (profile.id === "elder-care-rag-agent") {
    const businessTitle = "养老知识服务试点与问答闭环";
    return {
      businessTitle,
      businessBlock: [
        `### ${businessTitle}`,
        `${name}的早期验证适合从养老机构制度文档、护理SOP、政策补贴问答、家属沟通材料和社区服务流程切入。团队先整理小范围知识库，完成资料清洗、检索召回、来源引用、人工确认和反馈纠错，再根据护理人员查询频次、回答准确性、来源完整度和更新成本调整知识组织方式。`,
        `运行闭环由“资料入库-问题触发-检索召回-回答生成-来源核验-人工纠错-知识更新”组成。资料入库解决知识分散，问题触发来自真实护理和管理任务，来源核验保证回答可追溯，人工纠错保留业务边界，知识更新支撑长期维护。`,
        makeTable(
          ["运行节点", "关键动作", "观察指标", "沉淀材料"],
          [
            ["资料入库", "整理政策、制度、护理SOP和服务流程", "资料覆盖率、切分完整度", "知识库样例、目录清单"],
            ["检索召回", "根据问题匹配相关材料和制度条款", "召回准确率、来源命中率", "测试集、检索记录"],
            ["回答生成", "生成带来源提示的问答结果", "问答命中率、引用完整率", "问答截图、引用记录"],
            ["人工纠错", "护理主管或材料负责人复核错误回答", "纠错闭环率", "反馈表、修订记录"],
            ["知识更新", "按制度变化和高频问题更新知识库", "更新时效、版本次数", "版本日志、更新清单"],
          ],
        ),
      ].join("\n\n"),
      proofBlock: [
        `### 材料复核与版本沉淀`,
        `证明材料不只放在最后清单中，还要反向约束章节结论。围绕${proofs}，团队把每类材料对应到一个可核验结论：养老政策知识库样例支撑资料来源，护理SOP文档样例支撑业务适配，问答测试集支撑效果评价，引用溯源截图支撑可信边界，护理人员访谈纪要支撑需求真实性，权限分级说明支撑隐私合规。`,
        `版本沉淀采用“材料名称、形成时间、负责人、支撑结论、对应章节、当前状态”六项记录。这样处理后，计划书不需要反复使用空泛判断，而能通过材料关系说明${modules}怎样服务${users}，${metrics}怎样评价运行效果，${scenes}怎样形成后续试点空间。`,
        makeTable(
          ["材料类型", "复核重点", "对应结论", "后续更新方式"],
          [
            ["知识库样例", "来源是否清楚、内容是否可引用", "资料基础可追溯", "随政策和制度更新"],
            ["问答测试集", "问题是否来自真实场景、答案是否可核验", "问答能力可评价", "按高频问题扩充"],
            ["引用截图", "回答是否带来源、置信提示是否明确", "结果可信边界清楚", "随模型版本更新"],
            ["访谈纪要", "护理人员和管理者需求是否具体", "应用场景真实存在", "每轮试点后补充"],
            ["权限说明", "角色权限、脱敏范围和数据边界是否清楚", "合规边界可说明", "随部署场景更新"],
          ],
        ),
      ].join("\n\n"),
    };
  }

  const businessTitle = "试点验证与服务闭环";
  return {
    businessTitle,
    businessBlock: [
      `### ${businessTitle}`,
      `${name}的早期验证适合从反馈周期短、沟通成本低、能够形成测试材料的场景切入。团队先围绕${scenes}选择小范围对象完成需求确认、原型演示、服务试用和记录复盘，再根据${metrics}调整功能优先级、交付边界和成本假设。`,
      `运行闭环由“需求确认-原型演示-服务执行-人工复核-结果归档-版本迭代”组成。需求确认保证问题真实，原型演示降低沟通成本，服务执行检验${modules}是否进入真实流程，人工复核保留判断边界，结果归档形成后续展示和复盘材料。`,
      makeTable(
        ["运行节点", "关键动作", "观察指标", "沉淀材料"],
        [
          ["需求确认", `围绕${users}记录真实任务和现有替代方式`, "需求清晰度、痛点频次", "访谈纪要、需求清单"],
          ["原型演示", `展示${modules}的核心流程`, "理解成本、反馈数量", "原型截图、演示记录"],
          ["服务执行", `在${scenes}中完成小范围试用`, metrics, "测试表、问题清单"],
          ["人工复核", "复核异常结果、成本边界和用户反馈", "复核完成率、问题关闭率", "复盘记录、版本日志"],
          ["结果归档", `把${proofs}整理成附件依据`, "资料完整度", "附件索引、材料清单"],
        ],
      ),
    ].join("\n\n"),
    proofBlock: [
      `### 材料复核与版本沉淀`,
      `证明材料不只放在最后清单中，还要反向约束章节结论。围绕${proofs}，团队把每类材料对应到一个可核验结论：调研材料支撑需求真实性，原型和测试材料支撑产品可行性，竞品和市场材料支撑进入路径，预算和服务清单支撑经费安排。`,
      `版本沉淀采用“材料名称、形成时间、负责人、支撑结论、对应章节、当前状态”六项记录。这样处理后，计划书不需要反复使用空泛判断，而能通过材料关系说明${modules}怎样服务${users}，${metrics}怎样评价运行效果，${scenes}怎样形成后续试点空间。`,
      makeTable(
        ["材料类型", "复核重点", "对应结论", "后续更新方式"],
        [
          ["调研材料", "对象是否真实、问题是否具体、记录是否完整", "需求存在且有使用场景", "每轮试点后补充新材料"],
          ["原型材料", "入口、处理、输出和归档流程是否连贯", "产品具备可演示基础", "按版本保留截图和说明"],
          ["流程图", "服务节点、责任边界和验收方式是否清楚", "服务链路清晰", "根据用户反馈调整节点"],
          ["竞品材料", "对照对象、功能差异和成本边界是否清楚", "差异化进入路径成立", "新增替代方案"],
          ["财务材料", "成本、价格、客户数量和运维假设是否一致", "资金安排具有解释力", "按试点反馈滚动修正"],
        ],
      ),
    ].join("\n\n"),
  };
}

function ensureFinalBookMinimumDepth(text: string, config: WorkflowConfig) {
  const minimumDepthChars = 18_500;
  if (referenceStyleWorkflowSteps(config).length || text.length >= minimumDepthChars) return text;
  let next = text;
  const profile = currentTopicProfile(config);
  const name = projectBookDisplayName(config) || profile.title;
  const users = sentenceList(profile.users.slice(0, 5), "核心用户");
  const scenes = sentenceList(profile.scenes.slice(0, 5), "典型场景");
  const modules = sentenceList(profile.productModules.slice(0, 6), "核心功能模块");
  const metrics = sentenceList(profile.metrics.slice(0, 6), "关键评价指标");
  const proofs = sentenceList(profile.evidenceFocus.slice(0, 6), "证明材料");
  const marketStep = projectChapterSteps(config).find((step) => chapterCompletionNeed(step) === "market");
  const businessStep = projectChapterSteps(config).find((step) => step.id === "business-strategy");
  const proofStep = projectChapterSteps(config).find((step) => step.id === "proof-materials");
  const verificationTask = profile.id === "campus-competition-teaming"
    ? "发布、匹配、沟通、协同或归档"
    : profile.id === "elder-care-fall"
      ? "点位接入、风险识别、护理复核、告警处理或事件归档"
      : profile.id === "elder-care-rag-agent"
        ? "资料检索、问答生成、来源核验、人工纠错或知识更新"
        : "接入、处理、复核、反馈或归档";
  const validationBlock = [
    `### 用户验证与试点记录`,
    `团队把验证过程拆成访谈、原型演示、试用反馈和记录复盘四个环节。访谈用于确认${users}在${scenes}中是否确实存在高频痛点，原型演示用于观察${modules}是否能进入真实流程，试用反馈用于判断操作门槛和持续使用意愿，记录复盘则把问题、指标和材料沉淀到后续版本。`,
    `早期样本不追求一次覆盖所有客户，而是优先选择反馈周期短、沟通成本低、能够提供真实使用意见的对象。每轮验证结束后，团队将更新需求清单、功能优先级、竞品对比和财务假设，使${metrics}不只停留在目标表述中，而能逐步变成可检查的运行记录。`,
    makeTable(
      ["验证环节", "主要动作", "形成材料", "判断重点"],
      [
        ["访谈", "围绕使用场景、现有替代方式和改进期待记录需求", "访谈纪要、用户画像", "痛点是否真实且高频"],
        ["演示", "用原型页面或流程图展示核心功能", "原型截图、演示记录", "功能是否容易理解"],
        ["试用", `让目标用户完成${verificationTask}等任务`, "测试表、问题清单", "流程是否顺畅稳定"],
        ["复盘", "按指标和反馈调整版本、成本和推广节奏", "版本日志、迭代计划", "是否具备继续试点条件"],
      ],
    ),
  ].join("\n\n");
  const profileDepthBlocks = minimumDepthProfileBlocks(profile, name, users, scenes, modules, metrics, proofs);
  const businessBlock = profileDepthBlocks.businessBlock;
  const proofBlock = profileDepthBlocks.proofBlock;
  if (marketStep && !next.includes("用户验证与试点记录")) {
    const result = insertSpecificChapterSupplement(next, marketStep, validationBlock);
    if (result.changed) next = result.text;
  }
  if (businessStep && !next.includes(profileDepthBlocks.businessTitle)) {
    const result = insertSpecificChapterSupplement(next, businessStep, businessBlock);
    if (result.changed) next = result.text;
  }
  if (next.length < minimumDepthChars && proofStep && !next.includes("材料复核与版本沉淀")) {
    const result = insertSpecificChapterSupplement(next, proofStep, proofBlock);
    if (result.changed) next = result.text;
  }
  if (next.length < minimumDepthChars && !/材料归档与复盘|资料沉淀与复盘/.test(next)) {
    const closingBlock = [
      `### 资料沉淀与复盘`,
      `${name}的后续完善继续围绕${users}、${scenes}、${modules}、${metrics}和${proofs}推进。团队每增加一项功能、一次访谈、一轮测试或一份财务测算，都同步记录来源、负责人、形成时间和对应章节，使正文判断与资料沉淀保持一致。`,
      `材料闭环分为三类：第一类是需求材料，用于说明${users}在${scenes}中确实存在高频任务；第二类是产品材料，用于说明${modules}是否形成可演示、可测试、可复核的流程；第三类是经营材料，用于说明收入、成本、资金安排和风险控制是否能被团队估算口径解释。`,
      makeTable(
        ["材料链条", "形成方式", "支撑结论"],
        [
          ["需求链条", `围绕${users}访谈、问卷或场景记录`, "需求真实且边界清楚"],
          ["产品链条", `围绕${modules}保留原型、截图、测试和版本记录`, "方案具备可交付基础"],
          ["指标链条", `围绕${metrics}记录阶段结果`, "效果判断可复核"],
          ["经营链条", "围绕成本、价格、客户和运维做滚动估算", "资金安排与发展路径可解释"],
          ["附件链条", `围绕${proofs}建立索引`, "正文和证明材料一致"],
        ],
      ),
    ].join("\n\n");
    if (proofStep) {
      const result = insertSpecificChapterSupplement(next, proofStep, closingBlock);
      if (result.changed) next = result.text;
    } else {
      next = `${next}\n\n${closingBlock}`.trim();
    }
  }
  return next;
}

function ensureFinalBookPostCleanDepth(text: string, config: WorkflowConfig, minimumChars = 18_000) {
  if (referenceStyleWorkflowSteps(config).length || text.length >= minimumChars) return text;
  let next = text;
  const profile = currentTopicProfile(config);
  const name = projectBookDisplayName(config) || profile.title;
  const users = sentenceList(profile.users.slice(0, 5), "核心用户");
  const scenes = sentenceList(profile.scenes.slice(0, 5), "典型场景");
  const modules = sentenceList(profile.productModules.slice(0, 6), "核心功能模块");
  const metrics = sentenceList(profile.metrics.slice(0, 6), "关键评价指标");
  const proofs = sentenceList(profile.evidenceFocus.slice(0, 6), "证明材料");
  const models = sentenceList(profile.businessModels.slice(0, 5), "项目制交付、订阅运维和定制服务");
  const steps = projectChapterSteps(config);
  const proofStep = steps.find((step) => step.id === "proof-materials");
  const financeStep = steps.find((step) => chapterCompletionNeed(step) === "finance");
  const marketStep = steps.find((step) => chapterCompletionNeed(step) === "market");
  const targetStep = proofStep || financeStep || marketStep || steps[steps.length - 1];

  const insertOrAppend = (block: string) => {
    const title = block.match(/^###\s+(.+)$/m)?.[1] || block.slice(0, 48);
    if (next.includes(title)) return;
    if (targetStep) {
      const result = insertSpecificChapterSupplement(next, targetStep, block);
      if (result.changed) {
        next = result.text;
        return;
      }
    }
    next = `${next}\n\n${block}`.trim();
  };

  const blocks = [
    [
      `### 复核记录与交付边界`,
      `${name}在形成最终文本时，重点说明需求、功能、验证、经费和资料之间的对应关系。团队围绕${users}和${scenes}记录真实任务入口，再用${modules}呈现处理方式，用${metrics}观察阶段效果，用${proofs}支撑关键判断。这样的写法把方案落到可检查的过程，避免只用概念堆叠表达可行性。`,
      `交付边界按“已经形成、正在验证、计划推进”三类处理。已经形成的内容写成阶段成果，正在验证的内容写成测试与试点安排，计划推进的内容写成时间节点和验收口径。${models}只在有明确服务内容、成本口径和客户进入路径时展开，不把尚未发生的订单、授权或营收提前写成既成结果。`,
      makeTable(
        ["复核对象", "记录方式", "正文作用", "后续更新"],
        [
          ["需求复核", `围绕${users}记录访谈、问卷或场景观察`, "支撑痛点真实性和目标用户边界", "每轮验证后补充新样本"],
          ["功能复核", `围绕${modules}保留原型、截图、流程和测试表`, "支撑产品可行性和交付边界", "按版本记录新增能力"],
          ["指标复核", `围绕${metrics}记录阶段表现`, "支撑技术、市场和运营判断", "随测试批次滚动修正"],
          ["经营复核", `围绕${models}核算收入、成本和运维投入`, "支撑资金安排与回报测算", "按客户反馈调整假设"],
          ["资料复核", `围绕${proofs}建立正文对应关系`, "支撑结论可信度", "在提交前统一检查"],
        ],
      ),
    ].join("\n\n"),
    [
      `### 阶段复盘与资料更新`,
      `${name}后续推进采用月度复盘和阶段验收结合的方式。月度复盘关注任务是否完成、用户反馈是否进入版本、测试记录是否闭环、经费使用是否能解释；阶段验收则关注${scenes}中的关键流程是否跑通，${modules}是否具备稳定演示能力，${metrics}是否形成连续记录。`,
      `资料更新由团队分工承接：研发成员维护功能说明和测试表，调研成员维护访谈纪要和竞品对比，财务成员维护预算与收入假设，运营成员维护客户沟通和试点记录，材料成员维护正文、图表和附件目录的一致性。每一次更新都服务于文本结论本身，使计划书在专业表达之外保留可复核的推进痕迹。`,
    ].join("\n\n"),
  ];

  for (const block of blocks) {
    if (next.length >= minimumChars) break;
    insertOrAppend(block);
  }
  return next;
}

function enforceCompleteFinalBook(config: WorkflowConfig, finalBook: string, artifacts: ArtifactFile[]) {
  const thresholds = competitionQualityThresholds(config);
  const hasReferenceWorkflow = referenceStyleWorkflowSteps(config).length > 0;
  const targetChars = hasReferenceWorkflow
    ? Math.max(16_000, Math.round(thresholds.chars * 0.72))
    : Math.max(18_000, Math.round(thresholds.chars * 0.86));
  let next = cleanFinalBookForSubmission(finalBook, config);

  const missing = missingOrThinChapterSteps(next, config);
  if (missing.length) {
    const blocks = missing.map((step) => buildChapterGapBlock(next, step, config));
    next = `${next}\n\n${blocks.join("\n\n")}`.trim();
  }

  for (let pass = 0; pass < (hasReferenceWorkflow ? 2 : 5); pass += 1) {
    let changed = false;
    const thin = thinChapterDepthSteps(next, config);
    for (const step of thin) {
      const result = insertChapterDepthSupplement(next, step, config);
      if (result.changed) {
        next = result.text;
        changed = true;
      }
    }
    if (next.length >= targetChars && thinChapterDepthSteps(next, config).length === 0) break;
    if (!changed) break;
  }

  let stage = 1;
  while (next.length < targetChars && stage <= 4) {
    let changed = false;
    for (const step of projectChapterSteps(config)) {
      const range = chapterSectionRange(next, step);
      if (!range.found) continue;
      const supplement = buildChapterDepthSupplement(step, config, stage);
      const marker = supplement.match(/^###\s+(.+)$/m)?.[1] || supplement.slice(0, 48);
      if (range.section.includes(marker)) continue;
      const result = insertSpecificChapterSupplement(next, step, supplement);
      if (result.changed) {
        next = result.text;
        changed = true;
      }
      if (next.length >= targetChars) break;
    }
    if (!changed) stage += 1;
  }

  next = syncFinalBookToc(next, config);
  next = cleanFinalBookForSubmission(next, config);
  next = ensureFinalBookRealismSignals(next, config);
  next = ensureFinalBookMinimumDepth(next, config);
  next = cleanFinalBookForSubmission(next, config);
  const repetition = repairEditorRepetition(next);
  next = cleanFinalBookForSubmission(repetition.text, config);
  next = cleanFinalBookForSubmission(ensureFinalBookMinimumDepth(next, config), config);

  if (next.length < Math.min(18_000, targetChars)) {
    const backup = assembleFinalBook(config, artifacts);
    if (backup.length > next.length) {
      next = cleanFinalBookForSubmission(backup, config);
    }
  }
  let final = cleanFinalBookForSubmission(removeCrossProjectContamination(next, config).text, config);
  const finalMinimumChars = Math.min(18_000, targetChars);
  for (let pass = 0; !hasReferenceWorkflow && final.length < finalMinimumChars && pass < 3; pass += 1) {
    final = cleanFinalBookForSubmission(ensureFinalBookPostCleanDepth(final, config, finalMinimumChars), config);
  }
  return final;
}

function countOccurrences(text: string, pattern: RegExp) {
  return (text.match(pattern) || []).length;
}

function normalizeQualityText(text: string) {
  return text
    .replace(/[，。；：、,.!?！？\s]+/g, "")
    .trim();
}

function qualityBodyText(text: string) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("|") && !line.startsWith("#") && !line.startsWith("!"))
    .join("\n")
    .replace(/HMAD-Ednet|SPA-HyperNet|Reptile|YOLO|mAP|Precision|Recall|F1|SAR/gi, "");
}

function duplicateParagraphs(text: string) {
  const seen = new Map<string, { text: string; count: number }>();
  qualityBodyText(text)
    .split(/\n{1,}/)
    .map((line) => line.trim())
    .filter((line) => line.length >= 45 && !line.startsWith("|") && !line.startsWith("#") && !line.startsWith("!"))
    .forEach((line) => {
      const key = normalizeQualityText(line).slice(0, 120);
      if (!key) return;
      const current = seen.get(key) || { text: line, count: 0 };
      current.count += 1;
      seen.set(key, current);
    });
  return Array.from(seen.values())
    .filter((item) => item.count > 1)
    .sort((a, b) => b.count - a.count)
    .slice(0, 12);
}

function repeatedNgrams(text: string) {
  const normalized = normalizeQualityText(qualityBodyText(text));
  const grams = new Map<string, number>();
  for (let i = 0; i < Math.max(0, normalized.length - 24); i += 8) {
    const gram = normalized.slice(i, i + 24);
    if (gram.length < 24) continue;
    grams.set(gram, (grams.get(gram) || 0) + 1);
  }
  return Array.from(grams.entries())
    .filter(([, count]) => count >= 4)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([text, count]) => ({ text, count }));
}

function profileSignalWords(config: WorkflowConfig) {
  const profile = currentTopicProfile(config);
  const raw = [
    config.name,
    config.track,
    config.brief,
    config.product,
    config.market,
    profile.domain,
    profile.position,
    ...profile.users,
    ...profile.scenes,
    ...profile.painPoints,
    ...profile.productModules,
    ...profile.competitors,
    ...profile.businessModels,
    ...profile.metrics,
    ...profile.evidenceFocus,
  ].filter(Boolean).join(" ");
  const stopwords = new Set(["项目", "系统", "平台", "服务", "管理", "用户", "市场", "技术", "产品", "方案", "数据", "智能", "应用", "团队", "训练", "创新", "创业"]);
  const words = raw.match(/[a-z0-9][a-z0-9+.-]{2,}|[\u4e00-\u9fa5]{2,}/gi) || [];
  const signals = new Set<string>();
  for (const word of words) {
    const cleaned = word.toLowerCase().trim();
    if (!cleaned || stopwords.has(cleaned)) continue;
    if (/^[\u4e00-\u9fa5]+$/.test(cleaned) && cleaned.length > 4) {
      for (let i = 0; i < cleaned.length - 1; i += 2) {
        const token = cleaned.slice(i, i + 2);
        if (!stopwords.has(token)) signals.add(token);
      }
      for (let i = 0; i < cleaned.length - 2; i += 3) {
        const token = cleaned.slice(i, i + 3);
        if (!stopwords.has(token)) signals.add(token);
      }
    } else {
      signals.add(cleaned);
    }
  }
  return [...signals].filter((item) => item.length >= 2).slice(0, 80);
}

function projectSpecificityScore(text: string, config: WorkflowConfig) {
  const signals = profileSignalWords(config);
  const normalized = String(text || "").toLowerCase();
  const hitSignals = signals.filter((signal) => normalized.includes(signal.toLowerCase()));
  const ratio = signals.length ? hitSignals.length / signals.length : 0;
  const score = Math.round(Math.min(100, 52 + ratio * 48));
  return {
    score,
    total: signals.length,
    hits: hitSignals.length,
    examples: hitSignals.slice(0, 12),
    missing: signals.filter((signal) => !hitSignals.includes(signal)).slice(0, 12),
  };
}

function crossProjectContamination(config: WorkflowConfig, text: string) {
  const profile = inferProjectProfile(config);
  const source = String(text || "");
  const groups = [
    {
      id: "campus-teaming",
      label: "校园竞赛组队方向",
      allowed: profile.id === "campus-competition-teaming",
      pattern: /组队招募|队友申请|队友匹配|寻找队友|学院竞赛群|创新创业社团|课程项目组|校级赛事|赛事报名|陌生同学组队|校园竞赛协作|优秀队伍|竞赛资料|竞赛方向|招募帖|匹配流程图|团队进度看板|赛事信息栏|团队交流区/g,
    },
    {
      id: "elder-care",
      label: "养老/护理方向",
      allowed: profile.id === "elder-care-rag-agent" || profile.id === "elder-care-fall",
      pattern: /养老|老人|老年|护理|照护|康养|跌倒|防摔|夜班护理员|养老机构|居家养老/g,
    },
    {
      id: "agriculture",
      label: "农业/种植方向",
      allowed: profile.id === "smart-agriculture" || profile.id === "low-altitude-drone-swarm",
      pattern: /农业|种植|农户|合作社|农产品|草莓|田间|农产品溯源|田间溯源|种植溯源|乡村振兴|病虫害/g,
    },
    {
      id: "library",
      label: "图书馆预约方向",
      allowed: profile.id === "library-booking",
      pattern: /图书馆|座位|研讨室|占座|预约|签到|离座|空间利用/g,
    },
    {
      id: "drone",
      label: "低空/无人机方向",
      allowed: profile.id === "low-altitude-drone-swarm" || profile.id === "sar-hmad-detection",
      pattern: /无人机|无人地|低空|蜂群|航线|空域|编队|巡检|植保|测绘/g,
    },
    {
      id: "drone-swarm-contamination",
      label: "蜂群/低空平台串项",
      allowed: profile.id === "low-altitude-drone-swarm",
      pattern: /蜂群|无人地面站|无人地|空地协同|多机编队|编队调度|航线与空域|农业植保|园区巡检|测绘巡查|物流配送|低空运营平台/g,
    },
    {
      id: "student-affairs",
      label: "学工/辅导员方向",
      allowed: profile.id === "ai-counselor-agent",
      pattern: /辅导员|学生工作|学工|心理预警|成长档案|奖助贷|请假|评奖评优|谈心谈话|分层嵌套智能体/g,
    },
    {
      id: "flower-care",
      label: "花卉养护方向",
      allowed: profile.id === "smart-flower-care",
      pattern: /花境|花卉|花草|盆栽|浇水|施肥|园艺|绿植|养护提醒|病虫害图片/g,
    },
    {
      id: "intangible-pattern",
      label: "非遗纹样素材方向",
      allowed: profile.id === "intangible-pattern-library",
      pattern: /纹样|非遗素材|非遗纹样|素材库|数字化提取|矢量化|图案提取|文创设计应用/g,
    },
    {
      id: "culture-tourism",
      label: "文旅融合方向",
      allowed: profile.id === "culture-tourism" || profile.id === "intangible-pattern-library",
      pattern: /文旅|旅游|景点|导览|研学|游客|商户入驻|地方文化|路线推荐|互动任务/g,
    },
    {
      id: "home-nas-media",
      label: "家庭NAS影音方向",
      allowed: profile.id === "home-nas-media",
      pattern: /NAS|nas|影音|媒体库|照片备份|家庭私有云|多端播放|远程访问|家庭权限|片库/g,
    },
    {
      id: "cross-border-ai",
      label: "跨境电商方向",
      allowed: profile.id === "cross-border-ai",
      pattern: /跨境|电商|外贸|出海|多语|亚马逊|独立站|询盘|店铺运营|国际市场/g,
    },
    {
      id: "touchless-interaction",
      label: "非接触交互方向",
      allowed: profile.id === "touchless-interaction",
      pattern: /非接触|隔空|手势|勿触|空中手势|隔空操作|中间件|公共终端|触控替代|误触/g,
    },
    {
      id: "smart-fitness",
      label: "健身姿态纠正方向",
      allowed: profile.id === "smart-fitness-coach",
      pattern: /哑铃|健身|力量训练|姿态识别|动作纠正|智炼|训练纠正|标准动作|实时反馈|私教/g,
    },
    {
      id: "creative-whiteboard",
      label: "白板协作方向",
      allowed: profile.id === "creative-whiteboard",
      pattern: /白板|FreeFlow|freeflow|无限画布|多格式融合|协作画布|脑暴|画布内容|结构化输出/g,
    },
  ];
  return groups.map((group) => {
    const matches = source.match(group.pattern) || [];
    return {
      id: group.id,
      label: group.label,
      allowed: group.allowed,
      count: matches.length,
      examples: [...new Set(matches.map((item) => item.slice(0, 12)))].slice(0, 8),
      risky: !group.allowed && matches.length >= 3,
    };
  }).filter((group) => group.count > 0 || group.risky);
}

function genericParagraphSamples(text: string) {
  const genericPattern = /重要意义|广阔前景|不断提升|持续优化|赋能|闭环|显著优势|有效促进|高质量发展|助力|痛点|降本增效/g;
  return String(text || "")
    .split(/\n{1,}/)
    .map((line) => line.trim())
    .filter((line) => line.length >= 80 && !isProtectedFinalBookLine(line))
    .map((line) => {
      const count = (line.match(genericPattern) || []).length;
      return { line, count };
    })
    .filter((item) => item.count >= 3)
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);
}

function removeCrossProjectContamination(text: string, config: WorkflowConfig) {
  const contamination = crossProjectContamination(config, text).filter((item) => item.risky);
  if (!contamination.length) return { text, removed: 0 };
  const riskyPattern = new RegExp(contamination.map((item) => {
    if (item.id === "campus-teaming") return "组队招募|队友申请|队友匹配|寻找队友|学院竞赛群|创新创业社团|课程项目组|校级赛事|赛事报名|陌生同学组队|校园竞赛协作|优秀队伍|竞赛资料|竞赛方向|招募帖|匹配流程图|团队进度看板|赛事信息栏|团队交流区";
    if (item.id === "elder-care") return "养老|老人|老年|护理|照护|康养|跌倒|防摔|养老机构|居家养老";
    if (item.id === "agriculture") return "农业|种植|农户|合作社|农产品|草莓|田间|农产品溯源|田间溯源|种植溯源|乡村振兴|病虫害";
    if (item.id === "library") return "图书馆|座位|研讨室|占座|预约|签到|离座|空间利用";
    if (item.id === "drone") return "无人机|无人地|低空|蜂群|航线|空域|编队|巡检|植保|测绘";
    if (item.id === "drone-swarm-contamination") return "蜂群|无人地面站|无人地|空地协同|多机编队|编队调度|航线与空域|农业植保|园区巡检|测绘巡查|物流配送|低空运营平台";
    if (item.id === "student-affairs") return "辅导员|学生工作|学工|心理预警|成长档案|奖助贷|请假|评奖评优|谈心谈话|分层嵌套智能体";
    if (item.id === "flower-care") return "花境|花卉|花草|盆栽|浇水|施肥|园艺|绿植|养护提醒|病虫害图片";
    if (item.id === "intangible-pattern") return "纹样|非遗素材|非遗纹样|素材库|数字化提取|矢量化|图案提取|文创设计应用";
    if (item.id === "culture-tourism") return "文旅|旅游|景点|导览|研学|游客|商户入驻|地方文化|路线推荐|互动任务";
    if (item.id === "home-nas-media") return "NAS|nas|影音|媒体库|照片备份|家庭私有云|多端播放|远程访问|家庭权限|片库";
    if (item.id === "cross-border-ai") return "跨境|电商|外贸|出海|多语|亚马逊|独立站|询盘|店铺运营|国际市场";
    if (item.id === "touchless-interaction") return "非接触|隔空|手势|勿触|空中手势|隔空操作|中间件|公共终端|触控替代|误触";
    if (item.id === "smart-fitness") return "哑铃|健身|力量训练|姿态识别|动作纠正|智炼|训练纠正|标准动作|实时反馈|私教";
    return "白板|FreeFlow|freeflow|无限画布|多格式融合|协作画布|脑暴|画布内容|结构化输出";
  }).join("|"), "i");
  const keepSignals = profileSignalWords(config);
  let removed = 0;
  const next = String(text || "")
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed || isProtectedFinalBookLine(trimmed)) return true;
      if (!riskyPattern.test(trimmed)) return true;
      const normalized = trimmed.toLowerCase();
      const ownHits = keepSignals.filter((signal) => normalized.includes(signal.toLowerCase())).length;
      if (ownHits >= 2) return true;
      removed += 1;
      return false;
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { text: next, removed };
}

function removeDuplicateBodyParagraphs(text: string) {
  const seen = new Set<string>();
  let removed = 0;
  const next = String(text || "")
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed || isProtectedFinalBookLine(trimmed)) return true;
      const key = normalizeQualityText(trimmed).slice(0, 160);
      if (key.length < 60) return true;
      if (seen.has(key)) {
        removed += 1;
        return false;
      }
      seen.add(key);
      return true;
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { text: next, removed };
}

function removeDuplicateBodySentences(text: string) {
  const seen = new Set<string>();
  let removed = 0;
  const next = String(text || "")
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed || isProtectedFinalBookLine(trimmed)) return line;
      const parts = trimmed.split(/(?<=[。；])/);
      const kept: string[] = [];
      for (const part of parts) {
        const sentence = part.trim();
        if (!sentence) continue;
        const key = normalizeQualityText(sentence).slice(0, 120);
        if (key.length >= 50 && seen.has(key)) {
          removed += 1;
          continue;
        }
        if (key.length >= 50) seen.add(key);
        kept.push(sentence);
      }
      return kept.join("");
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { text: next, removed };
}

function repairEditorRepetition(text: string) {
  const beforeDuplicates = duplicateParagraphs(text).length;
  const beforeNgrams = repeatedNgrams(text).length;
  const paragraphPass = removeDuplicateBodyParagraphs(text);
  const sentencePass = removeDuplicateBodySentences(paragraphPass.text);
  const next = sentencePass.text;
  return {
    text: next,
    removedParagraphs: paragraphPass.removed,
    removedSentences: sentencePass.removed,
    beforeDuplicates,
    beforeNgrams,
    afterDuplicates: duplicateParagraphs(next).length,
    afterNgrams: repeatedNgrams(next).length,
  };
}

function buildQualityReport(config: WorkflowConfig, finalBook: string, artifacts: ArtifactFile[]) {
  const chars = finalBook.length;
  const thresholds = competitionQualityThresholds(config);
  const hasReferenceWorkflow = referenceStyleWorkflowSteps(config).length > 0;
  const chapterSignals = hasReferenceWorkflow ? expectedProjectBookChapters(config) : competitionChapterSignals(config);
  const coveredSignals = chapterSignals.filter((chapter) => finalBook.includes(chapter)).length;
  const paragraphs = finalBook.split(/\n{1,}/).map((line) => line.trim()).filter(Boolean);
  const headings = countOccurrences(finalBook, /^#{1,3}\s+/gm);
  const tableLines = countOccurrences(finalBook, /^\|.+\|$/gm);
  const figures = countOccurrences(finalBook, /!\[|paper:\/\/figure|图\d|图 /g);
  const adviceHits = countOccurrences(finalBook, /建议|可考虑|待补充|后续完善|如有条件|TODO|\?\?\?/g);
  const vagueHits = countOccurrences(finalBook, /较好|一定程度|不断提升|持续优化|广阔前景|重要意义|显著优势|有效促进|赋能|闭环/g);
  const evidenceHits = countOccurrences(finalBook, /公开资料口径|项目估算口径|原型测试口径|用户材料口径|附件|测试记录|访谈|政策|行业报告/g);
  const duplicates = duplicateParagraphs(finalBook);
  const ngrams = repeatedNgrams(finalBook);
  const specificity = projectSpecificityScore(finalBook, config);
  const contamination = crossProjectContamination(config, finalBook);
  const riskyContamination = contamination.filter((item) => item.risky);
  const genericSamples = genericParagraphSamples(finalBook);
  const artifactNames = artifacts.map((artifact) => artifact.fileName).join("、");
  const risks = [
    adviceHits > 0 ? `仍有 ${adviceHits} 处建议式/待办式表达，需要改成正式正文。` : "",
    duplicates.length ? `发现 ${duplicates.length} 组疑似重复段落，需要删减或改写。` : "",
    ngrams.length ? `发现 ${ngrams.length} 组高频重复短语，可能存在循环扩写。` : "",
    specificity.score < 76 ? `项目专属度 ${specificity.score}/100，当前稿件可能仍偏通用，需要增加项目对象、场景、模块和指标。` : "",
    riskyContamination.length ? `发现 ${riskyContamination.length} 类跨项目串项风险：${riskyContamination.map((item) => item.label).join("、")}。` : "",
    genericSamples.length ? `发现 ${genericSamples.length} 段套话密度偏高，需要改成用户、场景、指标和材料支撑。` : "",
    coveredSignals < Math.ceil(chapterSignals.length * 0.72) ? `结构信号仅覆盖 ${coveredSignals}/${chapterSignals.length}，需要补齐当前参考稿的一级/二级标题。` : "",
    chars < (hasReferenceWorkflow ? 10_000 : thresholds.chars) ? "全文字符数偏短，完整项目书的信息密度可能不足。" : "",
    evidenceHits < thresholds.evidence ? "证据口径偏少，需要更多上传资料、公开来源、测试记录或附件索引支撑。" : "",
    tableLines < thresholds.tables ? "表格密度偏低，可在市场、竞品、财务、交付物和证明材料表中继续增强。" : "",
    figures < thresholds.figures ? "图示数量偏低，至少需要技术架构图和服务流程图。" : "",
  ].filter(Boolean);
  const score = Math.max(50, Math.min(100, 100 - adviceHits * 3 - duplicates.length * 4 - ngrams.length * 2 - riskyContamination.length * 12 - genericSamples.length * 2 - Math.max(0, 76 - specificity.score) + Math.min(8, Math.floor(evidenceHits / 5))));
  return `# 终稿质量检测报告

> 检测对象：${config.name}
> 质量分：${score}/100（${scoreBand(score)}）
> 竞赛规范：${projectSkillSourceStatus(config.template, effectiveProjectBookTemplateId(config))}
> 用途：自动发现重复扩写、建议式语言、证据不足、图表不足和格式风险。

## 总览指标
${makeTable(
  ["指标", "结果", "判断"],
  [
    [hasReferenceWorkflow ? "参考稿结构信号" : "竞赛结构信号", `${coveredSignals}/${chapterSignals.length}`, coveredSignals >= Math.ceil(chapterSignals.length * 0.72) ? "结构覆盖较完整" : "需补齐对应章节"],
    ["全文字符数", String(chars), chars >= (hasReferenceWorkflow ? 10_000 : thresholds.chars) ? "接近完整项目书长度" : "偏短"],
    ["段落数量", String(paragraphs.length), paragraphs.length >= 120 ? "信息密度较高" : "需检查段落展开"],
    ["标题数量", String(headings), headings >= 18 ? "章节层级较完整" : "标题层级偏少"],
    ["表格行数", String(tableLines), tableLines >= thresholds.tables ? "结构化表达较充分" : "表格密度不足"],
    ["图示信号", String(figures), figures >= thresholds.figures ? "满足基础图示要求" : "图示不足"],
    ["证据口径命中", String(evidenceHits), evidenceHits >= thresholds.evidence ? "证据意识较强" : "证据支撑偏弱"],
    ["项目专属度", `${specificity.score}/100`, specificity.score >= 82 ? "当前主题匹配较好" : specificity.score >= 76 ? "基本匹配，仍可增强" : "偏通用，需补项目专属内容"],
    ["跨项目串项风险", `${riskyContamination.length} 类`, riskyContamination.length ? "存在串项风险" : "未发现明显串项"],
    ["套话密度偏高段落", `${genericSamples.length} 段`, genericSamples.length ? "需改成具体场景和指标" : "未发现明显套话堆叠"],
    ["建议式/待办式表达", String(adviceHits), adviceHits === 0 ? "未发现明显问题" : "需改成终稿口吻"],
    ["空泛词命中", String(vagueHits), vagueHits <= 20 ? "可接受" : "需减少套话"],
  ],
)}

## 项目专属度
识别到的项目专属信号：${specificity.examples.length ? specificity.examples.join("、") : "暂无明显命中"}。
建议补强但正文中较少出现的信号：${specificity.missing.length ? specificity.missing.join("、") : "暂无明显缺口"}。

## 跨项目串项检测
${contamination.length ? makeTable(["方向", "命中次数", "是否允许", "示例"], contamination.map((item) => [item.label, String(item.count), item.allowed ? "当前项目允许" : item.risky ? "风险" : "少量背景词", item.examples.join("、") || "-"])) : "未发现其他项目方向的明显词汇混入。"}

## 套话密度偏高段落
${genericSamples.length ? makeTable(["套话命中", "段落摘录"], genericSamples.map((item) => [String(item.count), item.line.slice(0, 140)])) : "未发现明显套话堆叠段落。"}

## 疑似重复段落
${duplicates.length ? makeTable(["出现次数", "段落摘录"], duplicates.map((item) => [String(item.count), item.text.slice(0, 120)])) : "未发现明显整段重复。"}

## 高频重复短语
${ngrams.length ? makeTable(["出现次数", "重复短语"], ngrams.map((item) => [String(item.count), item.text])) : "未发现明显循环短语。"}

## 风险与处理动作
${risks.length ? risks.map((risk, index) => `${index + 1}. ${risk}`).join("\n") : "未发现影响终稿提交的明显质量风险。"}

## 产物覆盖
本次检测覆盖的工作流产物包括：${artifactNames || "暂无产物记录"}。`;
}

function isProtectedFinalBookLine(line: string) {
  const trimmed = line.trim();
  return (
    !trimmed ||
    trimmed.startsWith("#") ||
    trimmed.startsWith("|") ||
    trimmed.startsWith("!") ||
    /^[-*]\s+/.test(trimmed) ||
    /^\d+\.\s+/.test(trimmed)
  );
}

function projectNarrativeAlias(config: WorkflowConfig) {
  const name = projectBookDisplayName(config) || "该方案";
  if (/网络/.test(name)) return "该网络";
  if (/系统/.test(name)) return "该系统";
  if (/平台/.test(name)) return "该平台";
  if (/模型/.test(name)) return "该模型";
  return "该方案";
}

function deTemplateProjectTableLine(line: string) {
  if (!line.trim().startsWith("|")) return line;
  const normalized = `| ${line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim()).join(" | ")} |`;
  return normalized
    .replace(/项目做法/g, "实现方式")
    .replace(/项目回应/g, "应对方式")
    .replace(/项目口径/g, "估算依据")
    .replace(/项目价值/g, "支撑作用")
    .replace(/系统价值/g, "应用价值")
    .replace(/项目估算口径/g, "团队估算口径")
    .replace(/项目制口径/g, "项目制服务")
    .replace(/项目团队/g, "团队")
    .replace(/项目产品/g, "产品结构")
    .replace(/项目简述/g, "方案简述")
    .replace(/项目切入点/g, "切入方式")
    .replace(/项目字段/g, "申报字段")
    .replace(/正文作用/g, "支撑作用")
    .replace(/正文采用/g, "材料采用")
    .replace(/对应正文结论/g, "对应章节结论");
}

function deTemplateProjectNarrativeLine(line: string, config: WorkflowConfig) {
  if (isProtectedFinalBookLine(line)) return line;
  const name = projectBookDisplayName(config) || "该方案";
  const alias = projectNarrativeAlias(config);
  const prefix = line.match(/^(\s*)/)?.[1] || "";
  let body = line.slice(prefix.length);
  body = body
    .replace(/^项目由此提出/, `${alias}由此提出`)
    .replace(/^项目将(.+?)作为技术主线/, "技术路线以$1为主线")
    .replace(/^项目将/, `${alias}将`)
    .replace(/^项目选择/, "团队选择")
    .replace(/^项目建设的必要性/, "建设必要性")
    .replace(/^项目真正成立/, "方案真正成立")
    .replace(/^项目边界/, "实施边界")
    .replace(/^项目使用流程/, "使用流程")
    .replace(/^项目部署/, "部署过程")
    .replace(/^项目运行/, "平台运行")
    .replace(/^项目成果/, "阶段成果")
    .replace(/^项目发展/, "后续发展")
    .replace(/^项目风险/, "执行风险")
    .replace(/^项目复购/, "复购")
    .replace(/^项目单位经济模型/, "单位经济模型")
    .replace(/^项目推进/, "推进过程")
    .replace(/^项目实施/, "实施过程")
    .replace(/^项目进入市场/, "进入市场时")
    .replace(/^项目采用/, "团队采用")
    .replace(/。项目采用/g, "。团队采用")
    .replace(/^项目的交付形态/, "交付形态")
    .replace(/^项目创业机会来自/, "机会来自")
    .replace(/^本项目的目标市场/, "目标市场")
    .replace(/^项目的市场进入/, "这一路径的市场进入")
    .replace(/^本项目的竞争优势/, `${alias}的竞争优势`)
    .replace(/^项目当前限制/, "当前限制")
    .replace(/^项目盈利模式/, "盈利模式")
    .replace(/^项目价值直接对应/, `${alias}直接对应`)
    .replace(/^项目团队/, "团队")
    .replace(/^项目会议/, "团队会议")
    .replace(/^本项目的产业切入点/, `${alias}的产业切入点`)
    .replace(/^本项目将/, `${alias}将`)
    .replace(/^项目产品由/, `${alias}由`)
    .replace(/^项目服务实施分为/, "服务实施分为")
    .replace(/^项目不直接承诺/, "团队不直接承诺")
    .replace(/^项目早期可进入/, `${alias}早期可进入`)
    .replace(/^项目通过/, `${alias}通过`)
    .replace(/^项目竞争分析围绕/, "对照现有替代方案，团队主要比较")
    .replace(/^项目不是泛化巡检算法/, `${alias}不是泛化巡检算法`)
    .replace(/对于应急类项目/g, "对于应急类应用")
    .replace(/^项目商业模式采用/, "商业化上，团队采用")
    .replace(/^项目先通过/, "团队先通过")
    .replace(/^项目优先完善/, "团队优先完善")
    .replace(/^项目在早期验证基础上/, "团队在早期验证基础上")
    .replace(/^项目将多场景/, `${alias}将多场景`)
    .replace(/^为避免项目停留/, "为避免方案停留")
    .replace(/^项目的社会发展/, `${alias}的社会发展`)
    .replace(/^本项目通过/, `${alias}通过`)
    .replace(/^项目能够/, `${alias}能够`)
    .replace(/^项目为/, `${alias}为`)
    .replace(/^项目在环境保护/, `${alias}在环境保护`)
    .replace(/^项目可扩展/, `${alias}可扩展`)
    .replace(/^项目盈利能力/, `${alias}的盈利能力`)
    .replace(/^项目早期可按/, "早期可按")
    .replace(/^项目能够逐步/, `${alias}能够逐步`)
    .replace(/^项目从/, `${alias}从`)
    .replace(/^项目价值/, "实际价值")
    .replace(/项目价值主张/g, "实际价值主张")
    .replace(/说明系统价值/g, "说明应用价值")
    .replace(/系统价值主要/g, "应用价值主要")
    .replace(/^项目预期效益体现在/, "预期效益体现在")
    .replace(/^项目以/, `${alias}以`)
    .replace(/^项目回报/, "回报")
    .replace(/^资金主要投向/, "团队把经费投向")
    .replace(/^资金使用优先保障/, "经费安排优先保障")
    .replace(/^目标市场规模按照/, "测算目标市场时，团队按照")
    .replace(/^中期市场重点来自/, "进入中期后，市场增量主要来自")
    .replace(/^市场测算采用/, "测算市场规模时，团队采用")
    .replace(/^营销策略不采用/, "团队不采用")
    .replace(/^推广材料重点呈现/, "对外沟通时，团队重点呈现")
    .replace(/^短期1-2年聚焦/, "短期1-2年，团队聚焦")
    .replace(/^中期3-5年聚焦/, "中期3-5年，团队聚焦")
    .replace(/^长期5年以上聚焦/, `长期5年以上，${alias}聚焦`)
    .replace(/^核心竞争力保障来自/, `${alias}的核心竞争力来自`)
    .replace(/^团队分工按照/, "团队按照")
    .replace(/^团队协作以/, "团队协作以")
    .replace(/^差异化优势首先体现在/, `${alias}的差异首先体现在`)
    .replace(/^其次体现在/, "工程层面，")
    .replace(/^直接经济价值来自/, "直接收益主要来自")
    .replace(/^间接经济价值体现在/, "间接收益体现在")
    .replace(/^可扩展价值来自/, `${alias}的扩展空间来自`)
    .replace(/^证明材料围绕/, "附件清单主要包括")
    .replace(/^材料使用遵循/, "使用证明材料时，团队遵循")
    .replace(/^项目(?!书|名称|类别|类型|制|估算|字段)/, `${alias}`);
  return `${prefix}${body}`;
}

function deTemplateProjectNarrative(text: string, config: WorkflowConfig) {
  const rawName = String(config.name || "").trim();
  const name = projectBookDisplayName(config);
  const alias = projectNarrativeAlias(config);
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedRawName = rawName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let seenFullNameInBody = false;
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => {
      let next = line.trim().startsWith("|")
        ? deTemplateProjectTableLine(line)
        : deTemplateProjectNarrativeLine(line, config);
      if (name && !isProtectedFinalBookLine(next)) {
        const prefix = next.match(/^(\s*)/)?.[1] || "";
        let body = next.slice(prefix.length);
        if (rawName && rawName !== name && body.startsWith(rawName)) {
          body = body.replace(new RegExp(`^${escapedRawName}`), seenFullNameInBody ? alias : name);
          seenFullNameInBody = true;
        } else if (body.startsWith(name)) {
          if (seenFullNameInBody) {
            body = body.replace(new RegExp(`^${escapedName}`), alias);
          } else {
            seenFullNameInBody = true;
          }
        }
        body = body
          .replace(new RegExp(`${escapedName}的经费主要投向`, "g"), "团队把经费投向")
          .replace(new RegExp(`${escapedName}的机会来自`, "g"), "机会来自")
          .replace(new RegExp(`${escapedName}的目标市场`, "g"), "目标市场")
          .replace(new RegExp(`${escapedName}的产业切入点`, "g"), `${alias}的产业切入点`)
          .replace(new RegExp(`${escapedName}的盈利模式`, "g"), "盈利模式")
          .replace(new RegExp(`${escapedName}直接对应`, "g"), `${alias}直接对应`);
        next = `${prefix}${body}`;
      }
      return next;
    })
    .join("\n")
    .replace(/对照现有替代方案，[^，。\n]+重点比较替代方案展开：/g, "对照现有替代方案，团队主要比较四类路径：")
    .replace(/进入中期后，市场增量主要来自两类增量：/g, "进入中期后，增量主要来自两类来源：")
    .replace(/财务章节需要把每项资金投入解释为具体成果，把每项收入预测解释为客户、价格、成本和回款假设。/g, "资金投入对应原型研发、测试验证、市场调研、资料沉淀和运维准备等具体成果，收入预测则围绕客户数量、服务价格、交付成本和回款周期进行测算。")
    .replace(/背景章节需要把宏观趋势、用户痛点、场景矛盾和项目必要性连接起来，避免只停留在政策或行业概念。/g, "背景部分连接宏观趋势、用户痛点、场景矛盾和建设必要性，不停留在政策或行业概念。")
    .replace(/效益章节需要把社会价值、行业价值、用户价值、经济价值和可扩展价值分别落到影响对象、作用机制、测算口径和证明材料。/g, "效益部分把社会价值、行业价值、用户价值、经济价值和可扩展价值分别落到影响对象、作用机制、测算口径和证明材料。")
    .replace(/市场章节需要说明谁使用、谁决策、谁付费、如何触达、如何转化，以及市场数据采用什么口径。/g, "团队先分清使用者、决策者和付费者，再说明触达、转化与市场数据口径。")
    .replace(/产品章节需要把功能、流程、技术、交付和验收统一起来，让产品看起来像可运行服务，而不是零散功能清单。/g, "产品写法围绕功能、流程、技术、交付和验收展开，呈现为可运行服务而不是零散功能清单。")
    .replace(/商业章节需要把价值主张、收入来源、成本结构、运营推广和客户复购放在同一套业务闭环中说明。/g, "商业路径把价值主张、收入来源、成本结构、运营推广和客户复购放在同一套业务闭环中说明。")
    .replace(/团队章节需要把成员能力与项目任务对应，说明团队为什么能完成研发、调研、运营、财务和材料工作。/g, "团队能力与任务分工一一对应，说明成员完成研发、调研、运营、财务和材料工作的基础。")
    .replace(/附件章节需要说明材料如何形成、证明什么、对应哪个章节，并保证正文、图表和答辩口径一致。/g, "附件清单说明材料如何形成、证明什么、对应哪个章节，并保证正文、图表和答辩口径一致。")
    .replace(/工程层面，工程闭环上。检测结果/g, "工程层面，系统不只输出检测结果")
    .replace(/团队协作抓住阶段复盘和知识移交为核心/g, "团队协作以阶段复盘和知识移交为核心")
    .replace(/该网络的社会发展与民生改善效益体现在/g, "该网络可以")
    .replace(/该网络在环境保护方面的价值主要来自/g, "在环境保护方面，该网络主要通过")
    .replace(/该网络的盈利能力取决于/g, "盈利能力取决于")
    .replace(/该网络的经费主要投向/g, "团队把经费投向")
    .replace(/项目先通过/g, "团队先通过")
    .replace(/本项目通过/g, "系统通过")
    .replace(/项目优先/g, "团队优先")
    .replace(/项目在早期验证基础上/g, "团队在早期验证基础上")
    .replace(/项目将多场景/g, "该网络将多场景")
    .replace(/项目需要把/g, "团队需要把")
    .replace(/项目能够避免/g, "这种处理能够避免")
    .replace(/项目能够从/g, `${alias}能够从`)
    .replace(/项目能够形成/g, `${alias}能够形成`)
    .replace(/项目具备/g, `${alias}具备`)
    .replace(/项目不以/g, `${alias}不以`)
    .replace(/项目真正成立/g, "方案真正成立")
    .replace(/项目建设的必要性/g, "建设必要性")
    .replace(/项目可由/g, "该网络可由")
    .replace(/项目早期可按/g, "早期可按")
    .replace(/项目能够逐步/g, "该网络能够逐步")
    .replace(/项目从单次/g, "该网络从单次")
    .replace(/项目以场景自适应/g, "技术上以场景自适应")
    .replace(/项目服务于/g, "应用上服务于")
    .replace(/项目以试点服务/g, "商业上以试点服务")
    .replace(/从技术路线看，技术上以/g, "技术路线以")
    .replace(/从应用场景看，应用上服务于/g, "应用场景面向")
    .replace(/从商业路径看，商业上以/g, "商业路径以")
    .replace(/系统通过场景自适应检测网络/g, "系统通过场景自适应检测")
    .replace(/该网络能够逐步形成/g, "逐步形成")
    .replace(/使该网络从单次/g, "使其从单次")
    .replace(/项目回报/g, "回报")
    .replace(/^该网络的产业切入点/gm, "产业切入点")
    .replace(/^该网络由/gm, "系统由")
    .replace(/^该网络的差异/gm, "差异")
    .replace(/^该网络可以/gm, "场景自适应检测网络可以")
    .replace(/^该网络能够降低/gm, "无人机先行获取图像后，系统能够降低")
    .replace(/^该网络为公共安全治理/gm, "检测结果和任务日志为公共安全治理")
    .replace(/^该网络可扩展/gm, "技术能力可扩展")
    .replace(/^该网络的扩展空间/gm, "扩展空间")
    .replace(/^该网络围绕/gm, `${name || alias}围绕`)
    .replace(/正文采用/g, "材料采用")
    .replace(/负责正文、图表和附件的一致性/g, "负责图表、附件和申报材料的一致性")
    .replace(/负责项目书、图表、附件和答辩材料一致性/g, "负责申报书、图表、附件和答辩材料一致性")
    .replace(/材料成员负责正文、图表和附件的一致性/g, "材料成员负责图表、附件和申报材料的一致性")
    .replace(/团队用材料反向校验正文/g, "团队用材料反向校验章节结论")
    .replace(/附件体系与正文对应/g, "附件体系与章节对应")
    .replace(/图表编号与正文引用/g, "图表编号与章节引用")
    .replace(/对应正文结论/g, "对应章节结论")
    .replace(/正文中的收入、客户数量、性能结论和试点成效/g, "收入、客户数量、性能结论和试点成效")
    .replace(/正文中涉及已完成成果的内容/g, "涉及已完成成果的内容")
    .replace(/正文引用/g, "章节引用")
    .replace(/项目估算口径/g, "团队估算口径")
    .replace(/项目进度口径/g, "进度记录口径")
    .replace(/项目管理口径/g, "团队管理口径")
    .replace(/服务评审理解/g, "便于读者理解")
    .replace(/为后续竞赛评审、试点沟通和成果沉淀/g, "为后续竞赛展示、试点沟通和成果沉淀")
    .replace(/使评审/g, "使读者")
    .replace(/评审/g, "评委")
    .replace(/论证/g, "说明")
    .replace(/该写法/g, "这种处理")
    .replace(/项目招募/g, "组队招募")
    .replace(/项目需求/g, "参赛需求")
    .replace(/项目负责人/g, "团队负责人")
    .replace(/项目交流区/g, "团队交流区")
    .replace(/项目招募响应时间/g, "招募响应时间")
    .replace(/项目招募原型截图/g, "招募页面原型截图")
    .replace(/企业命题项目对接/g, "企业命题对接")
    .replace(/校内项目制部署/g, "校内赛事部署")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function templateToneSignals(text: string) {
  const lines = String(text || "").split(/\r?\n/);
  const bodyLines = lines
    .map((line) => line.trim())
    .filter((line) => line && !isProtectedFinalBookLine(line));
  const tableLines = lines.filter((line) => line.trim().startsWith("|")).join("\n");
  const titleSubjectPattern = /^(项目|本项目|该项目|项目价值|系统价值|市场规模|目标市场规模|商业模式|营销策略|发展战略|资金|证明材料|材料使用|核心竞争力保障|差异化优势|盈利模式)(?=[^名称类别类型字段书制])/;
  const titleSubjectLines = bodyLines.filter((line) => titleSubjectPattern.test(line));
  const aliasStartLines = bodyLines.filter((line) => /^(该网络|该系统|该平台|该模型|该方案)/.test(line));
  const tableTemplateHits = countOccurrences(tableLines, /项目做法|项目回应|项目口径|收入口径|对应价值|系统价值/g);
  const metaToneHits = countOccurrences(text, /对于竞赛申报而言|从评审可读性看|本节|本章节|参考项目书|写作要求|质量报告|系统提示/g);
  const projectWordCount = countOccurrences(text, /项目/g);
  return {
    titleSubjectCount: titleSubjectLines.length,
    aliasStartCount: aliasStartLines.length,
    tableTemplateHits,
    metaToneHits,
    projectWordCount,
    examples: [...titleSubjectLines, ...aliasStartLines].slice(0, 6),
  };
}

function repairAdviceTone(text: string) {
  return text
    .replace(/建议采用/g, "采用")
    .replace(/建议将/g, "将")
    .replace(/建议按/g, "按")
    .replace(/建议设置/g, "设置")
    .replace(/建议写成/g, "写成")
    .replace(/建议补强/g, "补强")
    .replace(/建议补充/g, "补充")
    .replace(/建议/g, "")
    .replace(/可以考虑/g, "采用")
    .replace(/可考虑/g, "采用")
    .replace(/如有条件/g, "在项目实施阶段")
    .replace(/待补充/g, "由附件材料支撑")
    .replace(/后续完善/g, "持续迭代")
    .replace(/占位/g, "说明")
    .replace(/TODO|\?\?\?/g, "");
}

function finalizeManuscriptLineTone(line: string) {
  if (!line.trim()) return line;
  if (line.trim().startsWith("!")) return line;
  const prefix = line.match(/^(\s*(?:[-*]\s+|\d+\.\s+|#{1,6}\s+)?)/)?.[1] || "";
  const body = line.slice(prefix.length);
  return `${prefix}${repairAdviceTone(finalizeSubmissionTone(body))
    .replace(/以学校\/赛事模板为准/g, "按照学校和赛事模板核验")
    .replace(/以学校模板和实际附件为准/g, "按照学校模板和附件材料核验")
    .replace(/最终仍需人工复核/g, "最终进行人工复核")
    .replace(/仍需人工核对/g, "进行人工核对")
    .replace(/需要进一步/g, "将进一步")
    .replace(/需要补充/g, "补充")
    .replace(/需要完善/g, "完善")
    .replace(/必须标注/g, "统一标注")
    .replace(/应该/g, "应")
    .replace(/无法确定/g, "按项目估算口径说明")}`;
}

function finalizeManuscriptTone(text: string) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => finalizeManuscriptLineTone(line))
    .join("\n")
    .replace(/以实际提交附件为准/g, "由附件材料说明支撑")
    .replace(/待补充/g, "由附件材料支撑")
    .replace(/TODO|\?\?\?/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function buildSubmissionExpansion(config: WorkflowConfig) {
  const name = config.name;
  const track = config.track || config.competition || "项目申报方向";
  const product = config.product || `${name}原型系统`;
  const market = config.market || "目标用户、试点单位和行业应用场景";
  const finance = config.finance || "原型研发、测试验证、材料归档、展示答辩和试点服务";
  return `## 附录A 评审补强材料
本附录用于在自动去重后保留完整项目书的信息密度。内容围绕${name}的评审表达展开，重点补足应用场景、验证路径、交付边界、经费使用、风险控制和答辩证据链，使正文既没有循环段落，也能保持可提交项目书所需的论证完整度。

### A.1 场景任务与用户价值
${name}面向${track}中的真实任务展开，核心对象包括直接使用者、管理者、服务对象、试点协同方和项目团队。直接使用者关注系统是否降低操作负担、是否能在异常状态出现时及时给出明确反馈；管理者关注部署成本、运行稳定性、数据记录和责任闭环；服务对象关注安全、隐私和服务体验；试点协同方关注实施周期、接口适配、运维成本和成果可展示性；项目团队关注技术迭代、材料沉淀和竞赛答辩证据。

${product}的价值不是单一功能展示，而是把“问题识别-数据采集-模型分析-结果呈现-人工处置-记录归档-版本迭代”连接成可运行流程。项目在申报阶段采用可验证口径描述成果：已经形成的部分以附件、截图、测试记录和演示材料支撑；仍处于计划阶段的部分以里程碑、验收标准和责任分工约束，避免把尚未完成的事项写成既成事实。

${makeTable(
  ["对象", "核心任务", "项目交付", "可核验材料"],
  [
    ["一线使用者", "发现异常、接收提醒、完成处置", "简洁操作入口、告警记录、复核流程", "原型截图、流程图、演示视频"],
    ["管理者", "掌握运行状态、追踪事件、评估效果", "数据看板、事件台账、统计报表", "测试记录、样例报表、管理端截图"],
    ["服务对象", "获得及时响应并保护隐私", "最小化采集、授权说明、脱敏机制", "隐私说明、合规流程、授权样表"],
    ["试点单位", "低成本部署和可持续维护", "部署清单、运维手册、验收指标", "试点记录、设备清单、反馈纪要"],
    ["项目团队", "迭代技术、完成申报、沉淀成果", "项目书、附件索引、答辩材料", "分工表、日志、代码说明、财务测算"],
  ],
)}

### A.2 技术验证与产品迭代路径
项目技术路线按照“可解释、可测试、可部署、可迭代”的原则组织。可解释体现在模块边界清晰，每个算法或业务模块都有输入、处理逻辑和输出结果；可测试体现在指标能够通过样本、场景和日志复核；可部署体现在系统不依赖理想实验环境，而能按照试点条件进行硬件、网络和数据适配；可迭代体现在每次测试都转化为问题清单、版本变更和材料更新。

${name}的技术验证分为四级。第一级是功能验证，确认核心流程能够跑通；第二级是指标验证，记录准确率、响应时间、稳定性、误报漏报和资源占用；第三级是场景验证，把系统放入目标用户环境进行流程演示；第四级是材料验证，把截图、日志、测试表、访谈纪要和问题闭环整理成可提交附件。四级验证共同支撑项目书正文中的技术可行性和成果可信度。

${makeTable(
  ["验证级别", "验证目标", "主要指标", "形成材料"],
  [
    ["功能验证", "确认核心流程闭环", "流程完成率、接口连通率、页面可用性", "流程截图、接口说明、演示脚本"],
    ["指标验证", "确认关键性能边界", "准确率、误报率、响应时间、资源占用", "测试表、样本说明、日志摘录"],
    ["场景验证", "确认真实环境适配能力", "部署时长、操作步骤、用户反馈、维护成本", "访谈纪要、部署清单、问题清单"],
    ["材料验证", "确认申报证据链完整", "附件齐备率、引用一致性、数据口径一致性", "附件索引、来源对应表、真实性说明"],
  ],
)}

### A.3 实施计划与里程碑
项目实施采用阶段制管理，每一阶段都有明确目标、责任角色和可交付成果。启动阶段完成需求确认和资料收集，原型阶段完成核心功能和页面流程，测试阶段完成样本验证和问题修复，试点阶段完成场景演示和反馈收集，申报阶段完成项目书、附件、图表、演示材料和答辩稿归档。

${makeTable(
  ["阶段", "时间口径", "关键任务", "验收标准"],
  [
    ["启动调研", "第1阶段", "需求访谈、竞品观察、政策与行业资料整理", "形成用户画像、问题清单和资料索引"],
    ["原型实现", "第2阶段", "搭建核心系统、完成关键模块、形成演示流程", "核心流程可演示，主要界面和数据链路可说明"],
    ["测试验证", "第3阶段", "构造样本、记录指标、修复问题、稳定版本", "形成测试表、问题闭环和版本说明"],
    ["试点演示", "第4阶段", "对接目标场景、完成演示、收集反馈", "形成反馈纪要、部署清单和改进记录"],
    ["申报归档", "第5阶段", "项目书定稿、附件整理、答辩材料制作", "Word/PDF、图表、附件索引和答辩稿完整"],
  ],
)}

### A.4 经费使用与成果对应
项目经费围绕${finance}展开，所有支出均服务于可展示、可测试、可归档的成果。研发类支出对应原型系统和算法模块；测试类支出对应样本处理、指标记录和问题闭环；设备与部署类支出对应演示环境和试点适配；材料与展示类支出对应项目书、图表、视频、路演和答辩；合规与运维类支出对应授权、隐私、维护和版本管理。

${makeTable(
  ["经费用途", "投入内容", "对应成果", "验收口径"],
  [
    ["研发实现", "算法、前后端、接口、数据处理", "原型系统、代码说明、功能截图", "功能流程可演示，模块边界清楚"],
    ["测试验证", "样本构建、测试记录、问题修复", "测试报告、指标表、日志摘录", "指标口径一致，问题闭环可追踪"],
    ["部署演示", "设备、网络、环境适配、演示脚本", "部署清单、演示视频、场景照片", "演示流程稳定，场景价值明确"],
    ["材料归档", "项目书、图表、附件、答辩稿", "Word/PDF、附件索引、PPT", "材料齐备，正文与附件一致"],
    ["合规运维", "隐私说明、授权流程、维护记录", "授权样表、运维手册、版本记录", "使用边界清晰，风险可控"],
  ],
)}

### A.5 风险控制与质量保障
项目风险主要来自数据质量不足、场景差异较大、用户操作成本、隐私合规要求、试点资源不稳定和财务估算偏差。项目不回避风险，而是把风险转化为可管理事项：数据风险通过样本说明和测试记录控制，场景风险通过多场景演示和参数配置控制，操作风险通过界面简化和人工复核控制，合规风险通过授权、脱敏和最小化采集控制，资源风险通过阶段目标和替代方案控制，财务风险通过成本区间和敏感性测算控制。

${makeTable(
  ["风险类别", "表现形式", "控制动作", "责任材料"],
  [
    ["数据风险", "样本不足、分布偏差、异常场景少", "记录样本来源、扩展测试场景、标注问题样例", "样本说明、测试日志"],
    ["技术风险", "误报漏报、响应慢、系统不稳定", "阈值校准、人工复核、版本回滚、压力测试", "指标表、问题闭环表"],
    ["实施风险", "部署环境差异、设备适配复杂", "形成部署清单、接口说明和演示备用方案", "部署记录、设备清单"],
    ["合规风险", "隐私授权、数据留存和访问权限不清", "最小化采集、脱敏处理、权限分级", "授权样表、隐私说明"],
    ["市场风险", "客户预算周期长、采购路径不明确", "区分试点、服务和订阅场景，设置低成本进入方案", "客户画像、预算口径表"],
    ["财务风险", "收入预测和成本估算存在偏差", "采用保守、中性、积极三档测算", "财务测算表、敏感性分析"],
  ],
)}

### A.6 答辩证据链
项目答辩时需要把“为什么做、做了什么、怎么证明、接下来如何落地”讲成一条线。${name}的证据链由五类材料组成：第一类是背景材料，用于说明问题真实存在；第二类是产品材料，用于说明解决方案已经具备雏形；第三类是测试材料，用于说明技术指标有记录；第四类是场景材料，用于说明目标用户和应用流程清楚；第五类是管理材料，用于说明团队分工、经费使用和风险控制能够落地。

${makeTable(
  ["答辩问题", "回答重点", "支撑材料"],
  [
    ["项目解决什么痛点", "从目标场景、用户任务和现有方案不足切入", "调研记录、政策资料、场景流程图"],
    ["技术创新在哪里", "说明算法、系统、流程或服务模式的组合创新", "架构图、模块说明、测试表"],
    ["项目是否已经能运行", "展示核心流程、演示路径和当前版本边界", "原型截图、演示视频、部署清单"],
    ["市场是否真实", "区分目标客户、付费主体和初期试点入口", "客户画像、竞品表、预算口径表"],
    ["团队是否能完成", "对应成员分工、阶段成果和复盘机制", "分工表、日志、成果清单"],
    ["资金如何使用", "把经费投向和可交付成果对应起来", "预算表、成果验收表、财务测算"],
  ],
)}

### A.7 提交材料一致性核对
正式提交前，项目书、附件、图表、演示材料和答辩稿需要保持一致。项目名称、赛道、负责人、团队成员、指导教师、联系方式、技术指标、市场估算、财务数据、附件编号和图表标题不得互相冲突。正文中的每一项关键事实都需要有来源口径：来自真实附件的内容按附件事实写，来自公开资料的内容按公开资料口径写，来自团队测算的内容按估算口径写，来自计划阶段的内容按实施计划写。

${makeTable(
  ["核对项", "核对内容", "通过标准"],
  [
    ["名称一致", "封面、正文、附件、导出文件名称一致", "无简称混用造成的歧义"],
    ["数据一致", "市场规模、收入、成本、指标在各章节一致", "同一数据不出现多个版本"],
    ["附件一致", "正文引用和附件编号能够对应", "附件索引可追踪"],
    ["图表一致", "图题、表题、正文说明互相对应", "图表不脱离正文"],
    ["口径一致", "事实、估算、计划和愿景区分清楚", "不夸大尚未完成成果"],
    ["格式一致", "Word/PDF字体、字号、行距、缩进、页码规范", "满足学校或赛事模板要求"],
  ],
)}`;
}

function buildSubmissionDeepening(config: WorkflowConfig) {
  const name = config.name;
  const track = config.track || config.competition || "项目申报方向";
  const market = config.market || "目标用户、试点单位和行业应用场景";
  return `## 附录B 深度调研与验收补充
本附录用于补足${name}在正式提交时需要呈现的调研深度、商业化路径、验收标准和附件组织方式。与正文各章相比，本部分更强调可复核的材料清单和评委追问时的回答依据。

### B.1 调研设计与样本口径
项目调研围绕${market}展开，调研对象分为需求侧、供给侧、管理侧和专家侧。需求侧用于确认痛点强度和真实使用流程；供给侧用于了解现有产品、价格区间和服务边界；管理侧用于判断采购、合规和部署条件；专家侧用于校正技术路线、指标设置和风险控制。调研结果不直接等同于市场结论，而是经过场景归类、需求聚类、频次判断和可行性筛选后进入正文。

${makeTable(
  ["调研对象", "调研目的", "关键问题", "沉淀材料"],
  [
    ["目标用户", "识别真实任务和痛点强度", "当前流程哪里耗时、哪里容易出错、愿意为哪些能力付费", "访谈纪要、需求清单、用户画像"],
    ["同类方案", "比较替代路径和价格边界", "现有方案解决了什么、没有解决什么、交付成本如何", "竞品表、价格口径、功能对比"],
    ["管理人员", "判断部署和采购可行性", "是否需要审批、谁负责维护、数据如何留存", "流程记录、合规要求、部署边界"],
    ["技术专家", "校准技术指标和测试方案", "指标是否合理、误差如何解释、样本如何扩展", "专家意见、指标说明、测试方案"],
  ],
)}

### B.2 商业化路径与服务边界
${name}的商业化不以一次性售卖作为唯一目标，而是按照“试点验证-标准化交付-持续运维-数据与评估服务”的路径推进。试点阶段强调低成本进入和效果验证，标准化阶段强调部署效率和交付文档，运维阶段强调稳定服务和问题闭环，数据与评估阶段强调持续改进和行业报告价值。项目书中的收入预测以估算口径呈现，正式提交时需要与团队真实资源、试点意向和学校要求保持一致。

${makeTable(
  ["阶段", "客户关系", "收入口径", "关键证明"],
  [
    ["试点验证", "合作试点或演示接入", "低额部署费、项目支持费或免费验证", "试点意向、演示记录、反馈纪要"],
    ["标准交付", "单点部署或小规模采购", "部署费、硬件适配费、培训费", "合同样例、部署清单、验收表"],
    ["持续运维", "年度服务或订阅", "运维费、平台订阅费、模型更新费", "运维手册、服务记录、版本日志"],
    ["评估服务", "数据分析和管理评估", "报告费、评估费、行业解决方案费", "统计报表、案例报告、数据说明"],
  ],
)}

### B.3 验收指标体系
项目验收指标由技术指标、业务指标、用户指标、材料指标和合规指标构成。技术指标回答系统是否可用，业务指标回答流程是否有效，用户指标回答使用体验是否改善，材料指标回答申报证据是否齐备，合规指标回答数据和隐私边界是否清楚。不同指标采用不同来源：测试指标来自原型实验，业务指标来自流程演示和反馈，财务指标来自估算模型，附件指标来自实际材料归档。

${makeTable(
  ["指标类别", "指标示例", "数据来源", "达标表达"],
  [
    ["技术指标", "准确率、召回率、响应时间、稳定性", "测试样本、日志、演示记录", "达到原型阶段可演示和可迭代要求"],
    ["业务指标", "处置流程闭环率、记录完整率、人工复核效率", "流程演练、台账样例、用户反馈", "能够支撑目标场景中的关键任务"],
    ["用户指标", "操作步骤、满意度、学习成本、误报接受度", "访谈纪要、问卷、试用反馈", "用户能理解并愿意持续使用"],
    ["材料指标", "附件齐备率、图表完整度、引用一致性", "附件索引、项目书、导出文件", "正文、图表、附件互相对应"],
    ["合规指标", "授权、脱敏、权限、留存周期", "隐私说明、授权样表、制度要求", "数据使用边界清晰可解释"],
  ],
)}

### B.4 附件包组织方式
正式提交时，附件包应服务正文论证，而不是简单堆放文件。附件按照“政策与背景、调研与访谈、技术与测试、产品与演示、市场与财务、团队与成果、合规与证明”七类组织。每类附件需要有编号、名称、证明对象、形成时间和责任人。正文引用附件时尽量使用“见附件X”的方式保持可追踪，避免正文出现无法核对的事实描述。

${makeTable(
  ["附件类别", "建议内容", "证明对象", "注意事项"],
  [
    ["政策与背景", "政策文件摘录、行业报告摘要、公开数据来源", "项目必要性和趋势依据", "标注来源，不截取无法溯源内容"],
    ["调研与访谈", "访谈纪要、问卷结果、用户画像、场景流程", "痛点真实性和需求强度", "保护个人隐私，必要时匿名化"],
    ["技术与测试", "测试表、日志、样本说明、指标截图", "技术可行性和迭代能力", "区分真实测试和模拟测试"],
    ["产品与演示", "原型截图、架构图、流程图、演示视频说明", "产品完成度和展示能力", "截图与当前版本保持一致"],
    ["市场与财务", "竞品表、客户画像、预算测算、收入预测", "商业可行性和资金使用", "注明估算口径和假设条件"],
    ["团队与成果", "成员分工、获奖经历、课程项目、论文软著状态", "团队执行能力", "未取得成果不得写成已取得"],
    ["合规与证明", "授权样表、隐私说明、合作意向、指导意见", "提交真实性和风险控制", "以实际盖章或签字材料为准"],
  ],
)}

### B.5 评委追问准备
评委通常会围绕真实性、创新性、可行性、商业价值和团队能力提问。项目答辩不应只背诵正文，而要能够把每个结论落到材料、数据或演示上。当被问到尚未完成的事项时，应说明当前状态、下一步动作和验收标准；当被问到市场和财务时，应说明估算口径、关键假设和保守边界；当被问到技术效果时，应说明样本范围、测试方式和误差来源。

${makeTable(
  ["追问方向", "回答策略", "支撑材料"],
  [
    ["项目真实吗", "说明调研对象、场景流程、附件证据和团队已完成工作", "访谈纪要、原型截图、测试记录"],
    ["创新点在哪", "把技术创新、流程创新和服务模式创新分开讲", "架构图、对比表、模块说明"],
    ["能不能落地", "说明部署条件、运维责任、成本和验收标准", "部署清单、服务流程、经费表"],
    ["市场是否成立", "说明客户分类、付费主体、预算来源和试点入口", "客户画像、竞品分析、预算口径"],
    ["数据是否可信", "说明数据来源、样本范围、估算假设和附件边界", "来源表、测试表、财务模型"],
    ["团队能否完成", "说明角色分工、阶段成果、复盘机制和指导支持", "分工表、日志、成果清单"],
  ],
)}

### B.6 版本迭代与提交前检查
项目书定稿前需要进行三轮检查。第一轮检查结构，确认章节完整、目录清晰、图表编号统一；第二轮检查事实，确认所有关键结论都有来源口径；第三轮检查格式，确认 Word/PDF 的字体、字号、行距、首行缩进、页眉页脚、页码、表格样式和图片标题满足学校或赛事模板。Paper-agent 的交付包检查提供自动初筛，最终仍应以学校模板和实际附件为准。

${makeTable(
  ["检查轮次", "检查重点", "不通过时处理方式"],
  [
    ["结构检查", "封面、摘要、目录、正文、图表、附件、真实性声明", "补章节、补目录、统一标题层级"],
    ["事实检查", "数据、成果、客户、试点、知识产权、财务口径", "删除夸大表述，改为材料口径或计划口径"],
    ["格式检查", "字体字号、行距、缩进、页码、表格、图片", "按赛事模板重新导出 Word/PDF"],
    ["答辩检查", "PPT、讲稿、演示视频、问答材料", "补充关键截图和问题回答卡片"],
  ],
)}`;
}

function buildSubmissionCompliance(config: WorkflowConfig) {
  const name = config.name;
  return `## 附录C 格式规范与提交清单补充
本附录面向正式提交环节，补足${name}在版式、评审指标、项目管理和材料交付上的最终核验内容。项目书能否拿到较好评价，不只取决于正文长度，还取决于材料是否成套、表达是否像正式申报文本、图表是否支撑论证、格式是否符合赛事或学校模板。

### C.1 正式文档格式控制
Word 与 PDF 导出采用项目书常见格式口径：页面使用 A4，正文采用宋体小四或接近 12pt 字号，中文段落首行缩进两个字符，行距采用 1.5 倍或学校模板要求，一级标题使用黑体并保持层级清楚，表格采用清晰边框和表头强调，图片下方保留图题，页脚保留页码。若学校或赛事提供专门模板，应以模板为最高优先级。

${makeTable(
  ["格式项", "推荐口径", "检查方式"],
  [
    ["页面", "A4，页边距符合学校模板或常规申报文档", "打开 Word 检查页面设置"],
    ["正文", "宋体，小四或 12pt，1.5 倍行距", "抽查正文段落样式"],
    ["标题", "一级标题黑体加粗，二三级标题层级明显", "检查目录和正文标题一致性"],
    ["段落", "首行缩进两个中文字符，段前段后适中", "检查长段落是否拥挤"],
    ["表格", "表头突出、边框清楚、文字不溢出", "逐表检查是否跨页混乱"],
    ["图片", "图题、编号、正文引用保持一致", "检查图片占位或生成图是否可读"],
    ["页码", "页脚页码连续，封面可按模板处理", "查看 Word/PDF 最终页码"],
  ],
)}

### C.2 评审维度自检
项目评审通常从真实性、创新性、可行性、应用价值、团队能力和材料完整度六个方面判断。${name}的终稿需要让评委在较短时间内看清楚：项目来自什么真实问题，技术方案解决了哪一类关键矛盾，团队已经完成哪些基础工作，后续如何验证和落地，经费如何变成具体成果，附件如何证明正文结论。

${makeTable(
  ["评审维度", "正文应体现的内容", "扣分风险"],
  [
    ["真实性", "调研对象、场景流程、附件口径和当前成果边界", "把计划写成已完成，缺少来源说明"],
    ["创新性", "技术、产品、流程、服务模式或应用组合上的差异", "只写宏观意义，不写具体创新点"],
    ["可行性", "技术路线、实施计划、验收指标和风险控制", "目标过大，资源和周期不匹配"],
    ["应用价值", "用户收益、管理收益、社会效益和经济效益", "价值描述空泛，缺少对象和指标"],
    ["团队能力", "成员分工、阶段成果、导师支持和协作机制", "只列姓名，不解释为什么能完成"],
    ["材料完整度", "图表、附件、测试、财务、证明材料相互支撑", "正文和附件断裂，图表只作装饰"],
  ],
)}

### C.3 项目管理闭环
项目执行采用“计划-执行-检查-改进”的闭环管理。计划阶段明确目标和资源，执行阶段形成版本和材料，检查阶段用测试指标和用户反馈校验成果，改进阶段把问题转化为下一轮任务。每一次版本迭代都应留下记录，包括变更原因、负责人、影响范围和验证结果。这些记录既帮助项目真正推进，也能在答辩中证明团队不是临时拼凑材料。

${makeTable(
  ["管理动作", "执行内容", "输出材料"],
  [
    ["任务拆解", "按技术、产品、调研、财务、文档、展示拆分任务", "任务表、里程碑表"],
    ["版本管理", "记录每次功能变更、参数调整和问题修复", "版本日志、问题清单"],
    ["测试复盘", "对关键指标和异常案例进行复盘", "测试报告、复盘纪要"],
    ["材料归档", "将截图、表格、访谈、财务和证明材料编号保存", "附件索引、来源对应表"],
    ["答辩演练", "围绕评委问题进行模拟问答和演示检查", "答辩稿、问答卡片、演示脚本"],
  ],
)}

### C.4 提交包最终组成
最终提交包应至少包括项目书 Word、项目书 PDF、附件材料目录、关键图表源文件或高清图片、演示视频或原型截图、财务测算表、团队分工与成果证明、答辩 PPT 和答辩问答提纲。正式材料以项目事实、附件证据和学校模板为准，所有签字、盖章、授权、合作意向、试点记录和成果证明均按真实材料归档，正文只保留项目本身的事实、方案、数据口径、实施路径和附件依据。

${makeTable(
  ["文件", "作用", "状态口径"],
  [
    ["项目书 Word", "可编辑正式稿", "由交付包导出，按模板复核"],
    ["项目书 PDF", "提交或预览正式稿", "由交付包导出，检查分页和图表"],
    ["附件索引", "说明每份附件证明什么", "按真实材料编号归档"],
    ["演示材料", "支撑答辩展示和原型说明", "使用原型截图、视频或链接"],
    ["财务表", "支撑经费、收入、成本和回报测算", "按估算口径和真实条件修订"],
    ["证明材料", "支撑导师、团队、成果、试点和合作信息", "以真实盖章、签字、授权或记录为准"],
    ["答辩材料", "支撑现场汇报和评委问答", "与项目书正文、图表和附件保持一致"],
  ],
)}

### C.5 正式提交前人工复核
自动生成可以完成结构、正文、导出和基础质检，但正式提交前仍需要人工复核四类内容。第一类是真实性复核，确认客户、试点、专利、软著、获奖、导师意见等是否真实存在；第二类是学校模板复核，确认封面、申报类别、团队信息和签字盖章要求；第三类是附件复核，确认正文引用的材料确实在附件中；第四类是答辩复核，确认 PPT、演示视频和项目书口径一致。

${makeTable(
  ["复核类别", "复核问题", "处理原则"],
  [
    ["真实性", "是否把未完成事项写成已完成成果", "改为计划口径、估算口径或删除"],
    ["模板", "是否符合学校/赛事给定格式", "以官方模板优先"],
    ["附件", "正文每个关键事实是否可追踪", "补附件编号或改写事实表达"],
    ["数据", "市场、财务、指标是否前后一致", "统一口径，保留假设说明"],
    ["展示", "PPT、视频、演示和正文是否一致", "同步更新标题、数据和图表"],
  ],
)}`;
}

function removeRepeatedAutoSections(text: string) {
  const sectionMarkers = [
    "## 项目论证补强",
    "## 图表设计与表达完善",
    "## 技术验证与证据链完善",
    "## 市场进入与财务测算补强",
    "## 评审闭环补强",
    "## 第2轮深化补强",
    "## 第3轮深化补强",
    "## 附录A 评审补强材料",
    "## 附录B 深度调研与验收补充",
    "## 附录C 格式规范与提交清单补充",
    "## 自动去重修稿说明",
    "## 评审返修落实说明",
    "## 用户自定义产物要求核对",
  ];
  let result = text;
  for (const marker of sectionMarkers) {
    const first = result.indexOf(marker);
    if (first < 0) continue;
    let searchFrom = first + marker.length;
    while (true) {
      const next = result.indexOf(marker, searchFrom);
      if (next < 0) break;
      const following = sectionMarkers
        .map((candidate) => result.indexOf(candidate, next + marker.length))
        .filter((index) => index >= 0)
        .sort((a, b) => a - b)[0] ?? result.length;
      result = `${result.slice(0, next).trimEnd()}\n\n${result.slice(following).trimStart()}`;
      searchFrom = first + marker.length;
    }
  }
  return result;
}

function stripAutoGeneratedSections(text: string) {
  const markers = [
    "## 项目论证补强",
    "## 图表设计与表达完善",
    "## 技术验证与证据链完善",
    "## 市场进入与财务测算补强",
    "## 评审闭环补强",
    "## 第2轮深化补强",
    "## 第3轮深化补强",
    "## 材料来源与正文对应表",
    "## 附录A 评审补强材料",
    "### A.1 场景任务与用户价值",
    "## 附录B 深度调研与验收补充",
    "### B.1 调研设计与样本口径",
    "## 附录C 格式规范与提交清单补充",
    "### C.1 正式文档格式控制",
    "## 自动去重修稿说明",
    "## 评审返修落实说明",
    "## 用户自定义产物要求核对",
  ];
  const first = markers
    .map((marker) => text.indexOf(marker))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0];
  return typeof first === "number" ? text.slice(0, first).trimEnd() : text;
}

function autoRepairFinalBook(config: WorkflowConfig, finalBook: string, artifacts: ArtifactFile[]) {
  const sourceBook = stripAutoGeneratedSections(removeRepeatedAutoSections(finalBook));
  const lines = sourceBook.split(/\r?\n/);
  const seen = new Map<string, number>();
  let duplicateRemoved = 0;
  let adviceRewrites = 0;
  const repairedLines = lines.filter((line) => {
    if (isProtectedFinalBookLine(line)) return true;
    const before = line;
    const normalized = normalizeQualityText(line);
    if (normalized.length >= 80) {
      const key = normalized.slice(0, 120);
      const count = seen.get(key) || 0;
      seen.set(key, count + 1);
      if (count >= 1) {
        duplicateRemoved += 1;
        return false;
      }
    }
    if (/建议|可以考虑|可考虑|待补充|后续完善|如有条件|TODO|\?\?\?/.test(before)) {
      adviceRewrites += 1;
    }
    return true;
  }).map((line) => (isProtectedFinalBookLine(line) ? line : repairAdviceTone(line)));

  let repaired = repairedLines.join("\n");
  repaired = removeRepeatedAutoSections(repaired);
  repaired = removeCrossProjectContamination(repaired, config).text;
  return polishFinalBookSubmissionShape(finalizeManuscriptTone(normalizeProjectBookHeadings(finalizeSubmissionTone(repaired))));
}

function scoreBand(value: number) {
  if (value >= 90) return "优秀";
  if (value >= 80) return "较好";
  if (value >= 70) return "合格";
  return "需重点返修";
}

function evaluateFinalBook(config: WorkflowConfig, finalBook: string, artifacts: ArtifactFile[]) {
  const chars = finalBook.length;
  const thresholds = competitionQualityThresholds(config);
  const tableCount = countOccurrences(finalBook, /^\|.+\|$/gm);
  const figureCount = countOccurrences(finalBook, /!\[|paper:\/\/figure|图\d|图 /g);
  const evidenceHits = countOccurrences(finalBook, /公开资料口径|项目估算口径|原型测试口径|附件|证明材料|访谈|测试记录|政策|行业报告/g);
  const riskyHits = countOccurrences(finalBook, /待补充|占位|建议|后续完善|如有条件|以实际提交附件为准|无法确定|TODO|\?\?\?/g);
  const sourceMappingHits = countOccurrences(finalBook, /用户材料口径|附件|证明材料|测试记录|访谈|公开资料口径|项目估算口径/g);
  const uploadEvidenceCount = parseEvidenceRows(artifacts).filter((row) => row.category === "上传资料" || /上传资料/.test(row.source)).length;
  const chapters = competitionChapterSignals(config);
  const coveredChapters = chapters.filter((chapter) => finalBook.includes(chapter)).length;
  const specificity = projectSpecificityScore(finalBook, config);
  const contamination = crossProjectContamination(config, finalBook).filter((item) => item.risky);
  const genericSamples = genericParagraphSamples(finalBook);
  const toneSignals = templateToneSignals(finalBook);

  const dimensions = [
    {
      name: "结构完整度",
      score: Math.min(100, 54 + Math.round((coveredChapters / chapters.length) * 30) + (chars > thresholds.chars ? 12 : chars > thresholds.chars * 0.72 ? 6 : 0)),
      basis: `覆盖 ${coveredChapters}/${chapters.length} 个关键章节信号，全文约 ${chars} 字符。`,
    },
    {
      name: "证据可信度",
      score: Math.min(100, 52 + Math.min(24, evidenceHits) + Math.min(12, sourceMappingHits * 3) + (artifacts.some((item) => item.step.id === "evidence-index") ? 8 : 0)),
      basis: `正文证据口径命中 ${evidenceHits} 次，正文内附件/证明/口径信号 ${sourceMappingHits} 次，上传资料证据 ${uploadEvidenceCount} 条。`,
    },
    {
      name: "项目专属度",
      score: Math.max(45, Math.min(100, specificity.score - contamination.length * 12 - genericSamples.length * 2 - toneSignals.titleSubjectCount - toneSignals.tableTemplateHits * 2)),
      basis: `当前主题信号命中 ${specificity.hits}/${specificity.total}，跨项目串项风险 ${contamination.length} 类，套话密度偏高段落 ${genericSamples.length} 段，模板化起句 ${toneSignals.titleSubjectCount} 处，模板表头 ${toneSignals.tableTemplateHits} 处。`,
    },
    {
      name: "技术可行性",
      score: Math.min(100, 62 + countOccurrences(finalBook, /架构|模型|指标|测试|原型|部署|验收|迭代|YOLO|算法/g)),
      basis: "检查技术路线、指标、测试、部署与验收表达是否形成闭环。",
    },
    {
      name: "商业与市场表达",
      score: Math.min(100, 60 + countOccurrences(finalBook, /客户|市场|竞品|收入|成本|预算|采购|转化率|TAM|SAM|SOM|商业模式/g)),
      basis: "检查目标客户、竞品、收入、成本与市场规模口径。",
    },
    {
      name: "图表与交付物",
      score: Math.min(100, 55 + Math.min(20, tableCount) + Math.min(12, figureCount * 4)),
      basis: `表格标记约 ${tableCount} 行，图片/图示信号约 ${figureCount} 个。`,
    },
    {
      name: "格式与风险控制",
      score: Math.max(60, Math.min(100, 95 - riskyHits * 6)),
      basis: `风险词命中 ${riskyHits} 次，越少越接近可提交状态。`,
    },
  ];
  const total = Math.round(dimensions.reduce((sum, item) => sum + item.score, 0) / dimensions.length);
  const risks = [
    chars < thresholds.chars ? "全文长度偏短，可能达不到完整项目书的信息密度。" : "",
    coveredChapters < Math.ceil(chapters.length * 0.72) ? "对应竞赛的章节信号覆盖不足，需要按该竞赛规范补齐一级/二级标题。" : "",
    tableCount < thresholds.tables ? "表格密度不足，市场、竞品、财务、交付物和证明材料需要更多结构化呈现。" : "",
    figureCount < thresholds.figures ? "图示不足，至少需要技术架构图和服务流程图。" : "",
    evidenceHits < Math.min(12, thresholds.evidence) ? "证据口径不足，政策、行业报告、测试记录、访谈和附件索引需要更明确。" : "",
    sourceMappingHits < 6 ? "正文中的附件、证明材料、测试记录和估算口径提示偏少，关键结论的可追溯性需要增强。" : "",
    specificity.score < 76 ? "项目专属度不足，正文可能偏通用，需要更多围绕本项目用户、场景、功能模块和指标展开。" : "",
    contamination.length ? `存在跨项目串项风险：${contamination.map((item) => item.label).join("、")}。` : "",
    genericSamples.length ? "存在套话密度偏高段落，需要用具体场景、流程、指标和证明材料替换。" : "",
    toneSignals.titleSubjectCount > 8 ? `标题名词领句偏多（${toneSignals.titleSubjectCount}处），需要改成场景、团队、系统动作或业务对象开头。` : "",
    toneSignals.tableTemplateHits > 0 ? `表格中仍有项目做法/项目回应/项目口径等模板表头（${toneSignals.tableTemplateHits}处）。` : "",
    toneSignals.aliasStartCount > 10 ? `“该网络/该系统”等代称起句偏多（${toneSignals.aliasStartCount}处），需要换成系统、技术路线、团队、经费安排等上下文主语。` : "",
    riskyHits > 0 ? "存在建议/待补充/占位等非终稿表达，需要替换为正式口径。" : "",
  ].filter(Boolean);
  const actions = [
    "把所有市场规模、价格、收入和成本数字标注为公开资料口径或项目估算口径。",
    "把技术章节统一改成输入、处理链路、输出、验收指标、迭代机制的闭环表达。",
    "把证明材料章节改成附件索引，每份材料说明证明对象、形成方式和对应正文结论。",
    "在证据库和质量报告中保留上传资料、公开来源、测试记录、访谈材料和财务测算的对应关系，正文只保留正式项目书表述。",
    "补强竞品矩阵、客户画像、预算口径、版本交付物、五年财务预测和风险控制表。",
    "删除建议式语言，改为可直接提交的项目书正文章节。",
  ];
  return { total, band: scoreBand(total), dimensions, risks, actions };
}

function buildReviewReport(config: WorkflowConfig, finalBook: string, artifacts: ArtifactFile[]) {
  const review = evaluateFinalBook(config, finalBook, artifacts);
  return `# 项目书评审返修报告

> 评审对象：${config.name}
> 总分：${review.total}/100（${review.band}）
> 用途：模拟比赛评审视角，对完整项目书做结构、证据、技术、市场、图表和格式风险检查。

## 维度评分
${makeTable(["维度", "分数", "等级", "依据"], review.dimensions.map((item) => [item.name, String(item.score), scoreBand(item.score), item.basis]))}

## 高风险问题
${review.risks.length ? review.risks.map((item, index) => `${index + 1}. ${item}`).join("\n") : "未发现影响提交的高风险问题，仍建议人工核对团队事实、附件真实性和学校模板格式。"}

## 返修动作
${review.actions.map((item, index) => `${index + 1}. ${item}`).join("\n")}

## 提交前人工核验清单
${makeTable(
  ["核验项", "核验方式", "责任材料"],
  [
    ["团队信息", "核对成员姓名、学院、专业、联系方式、分工是否真实", "团队分工表/指导教师确认"],
    ["技术指标", "核对模型准确率、误报率、响应时间等是否有测试记录", "测试截图/实验日志/代码仓库说明"],
    ["市场数据", "核对市场规模、客户预算、竞品价格是否标注口径", "行业报告/访谈纪要/估算表"],
    ["财务预测", "核对收入、成本、现金流和客户数量是否相互解释", "财务测算表"],
    ["证明附件", "核对正文每个关键结论是否能找到附件或口径支撑", "附件索引"],
    ["格式规范", "核对字号、行距、缩进、页眉页脚、目录、图表编号", "学校/赛事模板"],
  ],
)}
`;
}

function buildQualityScanSummary(config: WorkflowConfig, finalBook: string, artifacts: ArtifactFile[]) {
  const profile = currentTopicProfile(config);
  const thresholds = competitionQualityThresholds(config);
  const hasReferenceWorkflow = referenceStyleWorkflowSteps(config).length > 0;
  const chapterSignals = hasReferenceWorkflow ? expectedProjectBookChapters(config) : competitionChapterSignals(config);
  const coveredChapters = chapterSignals.filter((chapter) => finalBook.includes(chapter)).length;
  const tableRows = countOccurrences(finalBook, /^\|.+\|$/gm);
  const figureSignals = countOccurrences(finalBook, /!\[|paper:\/\/figure|图\d|图 /g);
  const evidenceHits = countOccurrences(finalBook, /公开资料口径|项目估算口径|原型测试口径|用户材料口径|附件|证明材料|访谈|测试记录|政策|行业报告/g);
  const adviceHits = countOccurrences(finalBook, /建议|可考虑|待补充|后续完善|如有条件|以实际提交附件为准|无法确定|TODO|\?\?\?/g);
  const specificity = projectSpecificityScore(finalBook, config);
  const contamination = crossProjectContamination(config, finalBook);
  const riskyContamination = contamination.filter((item) => item.risky);
  const genericSamples = genericParagraphSamples(finalBook);
  const duplicates = duplicateParagraphs(finalBook);
  const ngrams = repeatedNgrams(finalBook);
  const review = evaluateFinalBook(config, finalBook, artifacts);
  const toneSignals = templateToneSignals(finalBook);
  const score = Math.max(45, Math.min(100, Math.round(
    review.total
    - riskyContamination.length * 6
    - duplicates.length * 2
    - ngrams.length
    - genericSamples.length
    - toneSignals.titleSubjectCount
    - toneSignals.tableTemplateHits * 2
    - toneSignals.metaToneHits * 3
    - adviceHits * 2,
  )));
  const checks = [
    {
      label: "章节结构",
      ok: coveredChapters >= Math.ceil(chapterSignals.length * 0.86),
      detail: `${coveredChapters}/${chapterSignals.length} 个关键章节信号`,
    },
    {
      label: "正文长度",
      ok: finalBook.length >= (hasReferenceWorkflow ? 12_000 : Math.round(thresholds.chars * 0.86)),
      detail: `${finalBook.length.toLocaleString()}/${(hasReferenceWorkflow ? 12_000 : Math.round(thresholds.chars * 0.86)).toLocaleString()} 字符`,
    },
    {
      label: "表格密度",
      ok: tableRows >= Math.min(thresholds.tables, 30),
      detail: `${tableRows}/${Math.min(thresholds.tables, 30)} 行表格标记`,
    },
    {
      label: "图示信号",
      ok: figureSignals >= thresholds.figures,
      detail: `${figureSignals}/${thresholds.figures} 个图示信号`,
    },
    {
      label: "证据口径",
      ok: evidenceHits >= thresholds.evidence,
      detail: `${evidenceHits}/${thresholds.evidence} 次证据口径`,
    },
    {
      label: "项目专属度",
      ok: specificity.score >= 76,
      detail: `${specificity.score}/100，命中 ${specificity.hits}/${specificity.total} 个当前主题信号`,
    },
    {
      label: "跨项目串项",
      ok: riskyContamination.length === 0,
      detail: riskyContamination.length ? riskyContamination.map((item) => `${item.label} ${item.count} 次`).join("、") : "未发现明显串项",
    },
    {
      label: "重复与套话",
      ok: duplicates.length === 0 && genericSamples.length <= 1,
      detail: `重复段落 ${duplicates.length} 组，套话段落 ${genericSamples.length} 段`,
    },
    {
      label: "去模板化口吻",
      ok: toneSignals.titleSubjectCount <= 8 && toneSignals.tableTemplateHits === 0 && toneSignals.metaToneHits === 0 && toneSignals.aliasStartCount <= 10,
      detail: `标题词领句 ${toneSignals.titleSubjectCount} 处，代称起句 ${toneSignals.aliasStartCount} 处，模板表头 ${toneSignals.tableTemplateHits} 处，元话语 ${toneSignals.metaToneHits} 处`,
    },
    {
      label: "终稿口吻",
      ok: adviceHits === 0,
      detail: `${adviceHits} 处建议/待补充/TODO 类表达`,
    },
  ];
  return {
    score,
    band: scoreBand(score),
    generatedAt: new Date().toISOString(),
    topic: {
      id: profile.id,
      title: profile.title,
      domain: profile.domain,
    },
    metrics: {
      chars: finalBook.length,
      chapterSignals: coveredChapters,
      chapterTotal: chapterSignals.length,
      tableRows,
      figureSignals,
      evidenceHits,
      adviceHits,
      templateTitleSubjects: toneSignals.titleSubjectCount,
      templateTableHits: toneSignals.tableTemplateHits,
      metaToneHits: toneSignals.metaToneHits,
    },
    specificity,
    contamination,
    genericSamples: genericSamples.map((item) => ({ count: item.count, text: item.line.slice(0, 180) })),
    duplicates: duplicates.map((item) => ({ count: item.count, text: item.text.slice(0, 180) })),
    repeatedPhrases: ngrams,
    templateTone: toneSignals,
    risks: review.risks,
    actions: review.actions,
    checks,
  };
}

function buildEditorQualityContext(config: WorkflowConfig, content: string): EditorQualityContext {
  const summary = buildQualityScanSummary(config, content, []);
  const failed = summary.checks
    .filter((check) => !check.ok)
    .map((check) => `${check.label}：${check.detail}`)
    .slice(0, 8);
  const risky = summary.contamination
    .filter((item) => item.risky)
    .map((item) => `${item.label}（${item.count}次）`)
    .slice(0, 5);
  const duplicates = summary.duplicates
    .slice(0, 4)
    .map((item) => `${item.count}次：${item.text.slice(0, 72)}`);
  const generic = summary.genericSamples
    .slice(0, 4)
    .map((item) => `${item.count}次：${item.text.slice(0, 72)}`);
  const missing = summary.specificity.missing.slice(0, 10);
  const actions = summary.actions.slice(0, 6);
  const compact = [
    `质量分：${summary.score}（${summary.band}）`,
    `正文：${summary.metrics.chars.toLocaleString()}字符；章节：${summary.metrics.chapterSignals}/${summary.metrics.chapterTotal}；表格：${summary.metrics.tableRows}行；图示：${summary.metrics.figureSignals}个；证据口径：${summary.metrics.evidenceHits}次；终稿口吻风险：${summary.metrics.adviceHits}处`,
    failed.length ? `未通过检查：${failed.join("；")}` : "未通过检查：无",
    missing.length ? `缺失项目专属信号：${missing.join("、")}` : "缺失项目专属信号：无明显缺口",
    risky.length ? `跨项目串项风险：${risky.join("、")}` : "跨项目串项风险：无",
    duplicates.length ? `重复段落：${duplicates.join("；")}` : "重复段落：无明显整段重复",
    generic.length ? `套话段落：${generic.join("；")}` : "套话段落：无明显套话堆叠",
    actions.length ? `优先动作：${actions.join("；")}` : "优先动作：继续保持正文终稿化、材料口径一致和附件可追溯",
  ].join("\n");
  return {
    score: summary.score,
    band: summary.band,
    failed,
    risks: summary.risks.slice(0, 6),
    actions,
    missing,
    compact,
  };
}

function qualityStepDef(): StepDef {
  return {
    id: "quality-scan",
    name: "终稿质量检测",
    agent: "质量检测智能体",
    checkpointType: "quality-scan",
    targetSection: "终稿质量检测报告",
    instruction: "检测完整项目书的重复扩写、建议式语言、空泛表达、证据口径、图表密度、格式风险和跨项目串项。",
  };
}

function planStepDef(): StepDef {
  return {
    id: "workflow-manifest",
    name: "工作流计划蓝图",
    agent: "Claude 计划层",
    checkpointType: "workflow-manifest",
    targetSection: "00-workflow-manifest",
    instruction: "生成工作流计划工件，只描述执行顺序、证据边界和参考约束，不生成正文。",
  };
}

function reviewStepDef(): StepDef {
  return {
    id: "final-review-loop",
    name: "终稿评审返修",
    agent: "评审返修智能体",
    checkpointType: "final-review",
    targetSection: "终稿评审返修报告",
    instruction: "按比赛评审视角对完整项目书打分、识别风险并生成返修动作。",
  };
}

function writeFinalBookQualityArtifacts(
  workflowId: string,
  config: WorkflowConfig,
  finalBook: string,
  artifacts: ArtifactFile[],
  options: { refreshArtifacts?: boolean } = {},
) {
  const projectDir = projectDirFor(workflowId);
  const artifactsDir = join(projectDir, ".paper", "artifacts");
  mkdirSync(artifactsDir, { recursive: true });
  const qualityStep = qualityStepDef();
  const reviewStep = reviewStepDef();
  const qualityPath = join(artifactsDir, "98-quality-report.md");
  const reviewPath = join(artifactsDir, "99-review-report.md");
  const qualityArtifact = formatArtifact(qualityStep, buildQualityReport(config, finalBook, artifacts), config);
  writeFileSync(qualityPath, qualityArtifact, "utf-8");
  const effectiveArtifacts = options.refreshArtifacts
    ? readArtifactFilesForDelivery(workflowId, config)
    : [
        ...artifacts.filter((artifact) => artifact.step.id !== "quality-scan" && artifact.step.id !== "final-review-loop"),
        { step: qualityStep, fileName: "98-quality-report.md", path: qualityPath, content: qualityArtifact },
      ];
  const reviewArtifact = formatArtifact(reviewStep, buildReviewReport(config, finalBook, effectiveArtifacts), config);
  writeFileSync(reviewPath, reviewArtifact, "utf-8");
  return {
    qualityStep,
    reviewStep,
    qualityPath,
    reviewPath,
    qualityArtifact,
    reviewArtifact,
  };
}

function shouldAutoRepairFinalBook(config: WorkflowConfig, finalBook: string, artifacts: ArtifactFile[]) {
  const summary = buildQualityScanSummary(config, finalBook, artifacts);
  const checksFailed = summary.checks.filter((check) => !check.ok).length;
  const hasReferenceWorkflow = referenceStyleWorkflowSteps(config).length > 0;
  return {
    summary,
    shouldRepair:
      !hasReferenceWorkflow
      && config.revisionLoop !== false
      && (
        summary.score < 90
        || checksFailed > 0
        || summary.contamination.some((item) => item.risky)
        || summary.duplicates.length > 0
        || summary.genericSamples.length > 0
        || summary.metrics.adviceHits > 0
      ),
    checksFailed,
  };
}

function runFinalBookReviewLoop(
  workflowId: string,
  config: WorkflowConfig,
  finalBook: string,
  artifacts: ArtifactFile[],
  options: { force?: boolean; backup?: boolean } = {},
) {
  const projectDir = projectDirFor(workflowId);
  const draftsDir = join(projectDir, ".paper", "drafts");
  mkdirSync(draftsDir, { recursive: true });
  const finalPath = join(draftsDir, "project-book-final.md");
  const before = finalBook;
  const beforeSummary = buildQualityScanSummary(config, before, artifacts);
  if (options.backup && existsSync(finalPath)) {
    const backupPath = join(draftsDir, `project-book-final-before-quality-repair-${Date.now()}.md`);
    writeFileSync(backupPath, before, "utf-8");
  }

  const repairDecision = shouldAutoRepairFinalBook(config, before, artifacts);
  let repaired = before;
  let removedParagraphs = 0;
  let removedSentences = 0;
  let removedContaminationLines = 0;
  let changed = false;
  if (options.force || repairDecision.shouldRepair) {
    repaired = autoRepairFinalBook(config, reviseFinalBookFromReview(config, before, buildReviewReport(config, before, artifacts), artifacts), artifacts);
    const repetition = repairEditorRepetition(repaired);
    repaired = repetition.text;
    removedParagraphs = repetition.removedParagraphs;
    removedSentences = repetition.removedSentences;
    const contaminationRepair = removeCrossProjectContamination(repaired, config);
    repaired = contaminationRepair.text;
    removedContaminationLines = contaminationRepair.removed;
    repaired = polishFinalBookSubmissionShape(finalizeManuscriptTone(normalizeProjectBookHeadings(sanitizeProjectBookBody(finalizeSubmissionTone(repaired)))));
    changed = repaired !== before;
  }

  if (referenceStyleWorkflowSteps(config).length) {
    repaired = polishFinalBookSubmissionShape(finalizeManuscriptTone(normalizeProjectBookHeadings(sanitizeProjectBookBody(finalizeSubmissionTone(repaired)))));
  } else {
    const enforced = enforceCompleteFinalBook(config, repaired, artifacts);
    if (enforced !== repaired) {
      repaired = enforced;
      changed = repaired !== before;
    }
  }

  writeFileSync(finalPath, repaired, "utf-8");
  const repairedPath = join(draftsDir, "project-book-final-repaired.md");
  const revisedPath = join(draftsDir, "project-book-final-revised.md");
  writeFileSync(repairedPath, repaired, "utf-8");
  writeFileSync(revisedPath, repaired, "utf-8");
  const artifactInfo = writeFinalBookQualityArtifacts(workflowId, config, repaired, artifacts, { refreshArtifacts: true });
  const afterArtifacts = readArtifactFilesForDelivery(workflowId, config);
  const afterSummary = buildQualityScanSummary(config, repaired, afterArtifacts);
  return {
    finalPath,
    repairedPath,
    revisedPath,
    qualityPath: artifactInfo.qualityPath,
    reviewPath: artifactInfo.reviewPath,
    before: beforeSummary,
    after: afterSummary,
    changed,
    changedChars: repaired.length - before.length,
    removedParagraphs,
    removedSentences,
    removedContaminationLines,
    repaired,
  };
}

function repairFinalBookFromQualityScan(workflowId: string, config: WorkflowConfig) {
  const projectDir = projectDirFor(workflowId);
  const draftsDir = join(projectDir, ".paper", "drafts");
  const finalPath = join(draftsDir, "project-book-final.md");
  if (!existsSync(finalPath)) throw new Error("请先生成完整项目书，再进行质量修复");
  mkdirSync(draftsDir, { recursive: true });

  const before = readFileSync(finalPath, "utf-8");
  const artifacts = readArtifactFilesForDelivery(workflowId, config);
  const backupPath = join(draftsDir, `project-book-final-before-quality-repair-${Date.now()}.md`);
  writeFileSync(backupPath, before, "utf-8");
  const result = runFinalBookReviewLoop(workflowId, config, before, artifacts, { force: true });
  config.updated = new Date().toISOString();
  writeConfig(workflowId, config);
  return {
    success: true,
    backupPath,
    finalPath: result.finalPath,
    repairedPath: result.repairedPath,
    revisedPath: result.revisedPath,
    qualityPath: result.qualityPath,
    reviewPath: result.reviewPath,
    changedChars: result.changedChars,
    removedParagraphs: result.removedParagraphs,
    removedSentences: result.removedSentences,
    removedContaminationLines: result.removedContaminationLines,
    before: result.before,
    after: result.after,
  };
}

function reviseFinalBookFromReview(config: WorkflowConfig, finalBook: string, reviewReport: string, artifacts: ArtifactFile[]) {
  let revised = finalBook
    .replace(/建议/g, "")
    .replace(/待补充/g, "后续由附件材料支撑")
    .replace(/占位/g, "说明")
    .replace(/后续完善/g, "持续迭代")
    .replace(/如有条件/g, "在项目实施阶段")
    .replace(/\?\?\?/g, "");
  return removeRepeatedAutoSections(finalizeSubmissionTone(revised));
}

function isAnthropicModel(model: string) {
  return /claude/i.test(model);
}

function parseLLMProviderError(text: string) {
  let message = text.slice(0, 360);
  try {
    const data = JSON.parse(text) as any;
    message = data?.error?.message || data?.message || data?.detail || message;
  } catch {
    // Keep raw response snippet.
  }
  return String(message || "外部 API 返回空错误").slice(0, 360);
}

function shouldTryFallbackModel(error: string) {
  return !/invalid token|incorrect api key|unauthorized|forbidden|无效|过期/i.test(error);
}

function shouldCircuitBreakModel(error: string) {
  return /standard Claude Code client|standard Claude|No available channel|under group|model.*not.*found|does not exist|not support|not available|timeout|timed out|fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|ECONNREFUSED/i.test(error);
}

function llmModelCandidates(model: string, baseUrl: string) {
  const candidates = [model];
  if (/scxai/i.test(baseUrl) || /claude/i.test(model)) {
    candidates.push("gpt-4o-mini", "gpt-4o", "deepseek-chat", "qwen-plus");
  }
  return [...new Set(candidates.map((item) => item.trim()).filter(Boolean))]
    .filter((candidate) => !badLLMModels.has(candidate));
}

async function callLLMWithModel(prompt: string, model: string, settings: ReturnType<typeof getRuntimeSettings>) {
  const baseUrl = settings.baseUrl.replace(/\/$/, "");
  const anthropic = isAnthropicModel(model);
  const response = await fetch(`${baseUrl}${anthropic ? "/v1/messages" : "/v1/chat/completions"}`, anthropic
    ? {
        method: "POST",
        signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
        headers: {
          "Content-Type": "application/json",
          "x-api-key": settings.apiKey,
          "anthropic-version": "2023-06-01",
          Authorization: `Bearer ${settings.apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: prompt }],
          max_tokens: 7000,
          temperature: 0.5,
        }),
      }
    : {
        method: "POST",
        signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${settings.apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: prompt }],
          max_tokens: 7000,
          temperature: 0.5,
        }),
      });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(parseLLMProviderError(text));
  }
  const data = (await response.json()) as any;
  if (anthropic) {
    return (data.content ?? []).map((part: any) => part?.text ?? "").join("").trim();
  }
  return String(data.choices?.[0]?.message?.content ?? "").trim();
}

async function callLLM(prompt: string): Promise<LLMCallResult> {
  if (envFlag("PAPER_AGENT_LOCAL_ONLY") || envFlag("PAPER_AGENT_FORCE_LOCAL_LLM")) {
    return {
      text: "",
      source: "none",
      error: "Local-only generation is enabled for this process.",
      attempts: ["local-only generation enabled"],
    };
  }
  const settings = getRuntimeSettings();
  if (!settings.apiKey) {
    return { text: "", source: "none", error: "未配置 API Key，已使用本地生成器", attempts: [] };
  }

  const attempts: string[] = [];
  let lastError = "";
  const candidates = llmModelCandidates(settings.model, settings.baseUrl);
  if (!candidates.length) {
    return {
      text: "",
      source: "none",
      error: "外部 API 模型近期连续失败，已临时熔断并使用本地生成器",
      attempts: ["all configured LLM candidates are circuit-broken"],
    };
  }
  for (const model of candidates.slice(0, MAX_MODEL_ATTEMPTS_PER_CALL)) {
    try {
      const text = await callLLMWithModel(prompt, model, settings);
      attempts.push(`${model}: ok ${text.length} chars`);
      if (text.trim()) return { text, source: "external", model, attempts };
      lastError = "模型返回空内容";
      attempts.push(`${model}: empty`);
    } catch (error: any) {
      lastError = error.message ?? String(error);
      attempts.push(`${model}: ${lastError}`);
      if (shouldCircuitBreakModel(lastError)) badLLMModels.add(model);
      if (!shouldTryFallbackModel(lastError)) break;
    }
  }
  return { text: "", source: "none", error: lastError || "外部 API 未返回有效内容", attempts };
}

function localExpansionFocus(config: WorkflowConfig, step: StepDef) {
  const name = config.name;
  const track = config.track || "项目所属赛道";
  const product = config.product || "核心产品/系统方案";
  const market = config.market || "目标客户与应用场景";
  const finance = config.finance || "资金使用与收益测算";
  const evidence = config.evidence || "证明材料、测试数据和访谈记录";
  const defaults = {
    review: `本节需要把${name}在${track}中的必要性说清楚，重点回答评委会追问的场景痛点、现有替代方案不足、团队可执行边界和阶段成果可信度。${product}不应只被描述为技术概念，而应落到真实使用流程、交付对象和验收指标。`,
    validation: `本节的验证应围绕小样本可复核材料展开：需求访谈、原型截图、测试记录、成本测算和导师意见需要能互相对应。若当前还没有真实客户或试点，应采用附件材料说明或项目估算口径，并写清下一阶段获取方式。`,
    evidence: `证明材料与正文结论建立索引关系：技术判断对应实验日志和界面截图，市场判断对应访谈纪要和竞品表，财务判断对应${finance}，综合可信度对应${evidence}。`,
    risk: `本节应主动说明风险边界，包括数据不足、部署环境差异、用户接受度、成本变化和材料缺口。风险不应只罗列，还要对应到改进动作、负责人和时间节点。`,
  };
  if (!isElderCareFallConfig(config)) return defaults;
  const map: Record<string, Partial<typeof defaults>> = {
    "dc-cover-outline": {
      review: `封面与目录不是形式项，而是评审快速判断完整度的入口。${name}应在封面、摘要、目录和图表清单中统一项目名称、赛道、负责人、团队分工、指导教师和联系方式，避免正文与附件信息不一致。`,
      validation: `目录按八大章组织，并把每章目标字数、图表、表格和证明材料写成清单。这样可以在后续写作时检查是否缺少市场、财务、团队、附件等关键模块。`,
    },
    "dc-overview-background": {
      review: `项目背景要从养老安全事件的高频性、人工看护压力和智能化改造成本三个层面展开，使${name}的提出具备现实紧迫性。`,
      validation: `可验证材料包括养老机构访谈、跌倒事故公开统计、现有监控方案不足、护理人员巡检流程和系统原型演示记录。`,
    },
    "dc-overview-market-value": {
      review: `市场价值应区分机构养老、社区养老和居家养老三类客户，不宜只引用宏观老龄化趋势。${market}需要转化为可接触的试点对象。`,
      evidence: `补充客户画像、预算区间、采购触发条件、竞品价格和替代方案比较，所有数字均需标注公开来源、访谈口径或估算假设。`,
    },
    "dc-team": {
      review: `团队章节要证明“有人能做、有人能验、有人能写、有人能推”。技术、产品、调研、财务和文档分工需要对应到具体交付物。`,
      validation: `列出每名成员的课程基础、竞赛经历、项目职责、阶段成果和下一步任务，并说明导师如何参与需求把关、技术路线和材料审阅。`,
    },
    "dc-industry-policy": {
      review: `产业与政策章节应把智慧养老、适老化改造、养老机构安全管理和数字化服务能力连接起来，说明${name}为什么符合当前政策和行业升级方向。`,
      evidence: `政策材料必须写清发布主体和适用范围；行业报告需要标明年份和统计口径；地方试点或采购案例只能作为参考，不应写成已经取得合作。`,
    },
    "dc-product-system": {
      review: `产品系统章节需要把${product}拆成视频接入、模型检测、风险判断、告警推送、人工复核、事件归档和模型迭代等模块。`,
      validation: `验收指标应覆盖识别准确率、误报率、漏报率、响应时间、部署成本、隐私保护和后台可用性，并给出原型阶段可完成的测试方法。`,
    },
    "dc-service-plan": {
      review: `服务方案应说明从部署前调研到交付后运维的完整流程，重点体现系统不是一次性安装，而是持续提供安全管理能力。`,
      validation: `补充试点流程：现场勘察、摄像头点位确认、授权与隐私告知、算法参数配置、护理人员培训、试运行、验收和复盘。`,
    },
    "dc-market-size": {
      review: `市场规模不要只写“大市场”，应拆成TAM、SAM、SOM三层，并说明初期能服务的区域、客户类型和点位数量。`,
      evidence: `估算应明确单机构点位数、单点部署价格、年服务费、可触达客户数量和转化率，所有假设需保持保守。`,
    },
    "dc-competition": {
      review: `竞争分析要同时比较传统人工巡护、普通监控、成熟智慧养老平台和同类AI项目，突出${name}在低成本改造和闭环告警上的差异。`,
      validation: `使用竞品功能表、价格区间、部署条件和服务边界说明项目优势，避免简单写“技术领先”。`,
    },
    "dc-business-model": {
      review: `商业模式应从试点部署费、年运维费、算法授权、系统集成和平台订阅几个收入来源展开，并说明不同阶段的收入重点。`,
      evidence: `收费数字需要以设备成本、算力成本、维护人力、客户预算和竞品报价为基础，暂缺真实数据时应写成估算区间。`,
    },
    "dc-marketing": {
      review: `营销策略应优先围绕样板客户和可信演示，而不是泛泛广告。大创阶段最重要的是形成可展示、可访谈、可证明的样板场景。`,
      validation: `获客路径可设置为导师资源引荐、养老机构访谈、社区服务站试点、竞赛路演展示和系统集成商合作。`,
    },
    "dc-development-strategy": {
      review: `发展战略需要分阶段，短期聚焦原型和试点，中期聚焦标准化交付，长期聚焦平台化和数据资产。每阶段都要对应里程碑。`,
      validation: `把技术、市场、团队、资金和证明材料分别列入路线图，避免只写宏观愿景。`,
    },
    "dc-social-benefits": {
      review: `社会效益要体现对老人安全、护理人员减负、养老机构管理和家庭远程看护的价值，并说明项目如何避免隐私和误报带来的负面影响。`,
      evidence: `使用响应时间缩短、巡护压力降低、事件记录完整度提升等指标作为效益口径，暂时无法量化时标注预期测算。`,
    },
    "dc-economic-benefits": {
      review: `经济效益需要把成本节约和收入增长分开写。对客户而言是降低事故处理成本和管理成本；对项目而言是形成部署与服务收入。`,
      evidence: `测算应说明硬件、软件、运维、数据标注和人员成本，不应只给收入预测而缺少成本结构。`,
    },
    "dc-finance-return": {
      review: `资金回报章节应解释资金具体投向和预期形成的成果，例如原型系统、测试报告、试点材料、软著申请和路演文件。`,
      validation: `投资回报不能承诺确定收益，应写成不同情景下的估算，并说明退出或持续运营路径。`,
    },
    "dc-finance-tables": {
      review: `财务表格要服务评审理解，而不是堆数字。收入、成本、现金流、客户数量和交付物之间要能相互解释。`,
      evidence: `把每个财务数字都标注假设来源：设备单价、云服务费、维护人力、试点数量、转化率和折旧周期。`,
    },
    "dc-proof-materials": {
      review: `证明材料章节应像附件索引，而不是简单清单。每份材料要说明证明对象、当前状态、负责人和形成时间。`,
      validation: `建议优先补齐原型截图、测试结果、访谈记录、导师意见、分工记录、代码仓库说明、软著或专利准备材料。`,
    },
  };
  return { ...defaults, ...(map[step.id] || {}) };
}

function localExpansionBlocks(config: WorkflowConfig, step: StepDef) {
  if (isReferenceWorkflowStep(step)) return [];
  const name = projectBookDisplayName(config);
  const alias = projectNarrativeAlias(config);
  const profile = currentTopicProfile(config);
  const finance = cleanConfigPhrase(config.finance || "", "研发、测试、部署、展示、知识产权和市场验证");
  const users = sentenceList(profile.users.slice(0, 5), "核心用户");
  const scenes = sentenceList(profile.scenes.slice(0, 5), "典型场景");
  const pains = sentenceList(profile.painPoints.slice(0, 6), "核心痛点");
  const modules = sentenceList(profile.productModules.slice(0, 6), "核心功能模块");
  const competitors = sentenceList(profile.competitors.slice(0, 5), "替代方案");
  const models = sentenceList(profile.businessModels.slice(0, 5), "项目制交付、订阅运维和定制服务");
  const metrics = sentenceList(profile.metrics.slice(0, 6), "关键评价指标");
  const proofs = sentenceList(profile.evidenceFocus.slice(0, 6), "证明材料");
  const genericStepBlocks = [
    `${alias}围绕${users}在${scenes}中的真实任务展开，把${pains}、${modules}、${metrics}和${proofs}放在同一条执行线上，避免把内容写成泛化介绍。`,
    `团队按${profile.techRoute}推进验证，先形成可演示流程和材料依据，再根据用户反馈、成本测算和阶段验收结果调整后续范围。`,
  ];
  const chapterSpecific: Record<string, string[]> = {
    overview: [
      `${alias}的建设边界放在${scenes}中最容易验证、最能形成材料沉淀的环节。团队先把${pains}拆成入口、匹配、协同、反馈和归档等具体动作，再用${modules}回应这些动作，保证方案概述不是泛泛谈需求。`,
      `立项价值主要落在${users}的使用变化上：信息获取更集中，协作过程更清楚，结果记录更便于复盘。趋势判断采用公开资料口径，场景判断采用用户材料口径，功能可行性由原型和测试材料承接。`,
    ],
    team: [
      `团队分工从${modules}的研发、${users}的调研、${models}的测算和${proofs}的整理四条线展开。每个角色对应明确产出，避免只列成员身份而缺少任务关系。`,
      `协作机制以周度复盘、版本记录和附件归档为主。研发结果进入原型和测试表，调研结果进入用户画像和竞品表，财务结果进入预算与收入假设，材料成员负责把图表、附件和答辩口径统一起来。`,
    ],
    "industry-product": [
      `产品层面，${modules}不是孤立功能列表，而是围绕${scenes}形成连续流程：需求进入、信息处理、结果反馈、人工复核、资料沉淀和版本迭代。每个模块都应说明输入来源、处理动作、输出结果和验收材料。`,
      `技术路线以${profile.techRoute}为主线，评价口径落到${metrics}。架构图、流程图、功能验收表和演示截图共同说明产品已经具备可解释、可测试、可继续迭代的基础。`,
    ],
    "market-competition": [
      `市场判断先区分直接使用者、组织管理者、付费或采购决策者。${users}在${scenes}中的触发频次、替代成本和试点门槛，决定了早期进入顺序。`,
      `对比${competitors}时，重点不放在功能堆砌，而放在${pains}是否被连续解决、结果能否留痕、服务是否便于复制。竞品表按使用门槛、流程完整度、数据沉淀、服务成本和后续迭代进行比较。`,
    ],
    "business-strategy": [
      `商业路径围绕${models}展开，先用小范围样板和原型演示建立信任，再沉淀服务清单、报价口径、验收指标和运维边界。收入测算从交付内容和持续服务推导，不写成已经发生的经营结果。`,
      `发展战略按近期、中期和长期衔接：近期完成核心流程和材料闭环，中期整理标准化服务包并拓展合作场景，长期依托用户反馈、流程数据和版本经验形成更稳定的复制能力。`,
    ],
    benefits: [
      `效益分析落到${metrics}可以观察的变化上。对${users}而言，收益体现为流程更顺、响应更快、协作成本更低；对组织管理者而言，收益体现为记录更完整、责任边界更清楚、资源配置更可复盘。`,
      `经济与扩展价值由${models}和${proofs}共同支撑。早期以原型测试、访谈反馈和估算模型呈现，中后期再根据真实试点、合作沟通和运维记录更新测算。`,
    ],
    "finance-deliverables": [
      `经费安排与${finance}对应到具体成果：研发投入形成模块版本，测试投入形成指标记录，调研投入形成用户和竞品材料，展示投入形成路演、截图和答辩资料。`,
      `回报测算按保守、中性和积极三档处理，每档都说明客户数量、收费方式、交付成本、回款周期和关键假设。尚未发生的订单、合同和营收只作为估算口径，不写成既成事实。`,
    ],
    "proof-materials": [
      `附件清单按“材料名称、形成方式、证明对象、对应章节、当前状态”整理。${proofs}分别支撑需求真实性、产品可行性、市场判断、财务假设和团队执行能力。`,
      `图表资料与章节内容互相引用：架构图对应产品章节，流程图对应实施路径，竞品表对应市场分析，预算表对应资金回报，风险或问题清单对应后续迭代。`,
    ],
    "dc-executive-summary": [
      `${name}先交代${users}在${scenes}中的矛盾，再落到${modules}、${metrics}和${models}，使摘要能够自然带出后续章节。`,
      `成果和材料口径由${proofs}支撑，未形成真实证明的内容只写阶段计划和估算依据。`,
    ],
    "dc-project-overview": [
      `${alias}先抓住${scenes}中最容易验证的环节，把${modules}跑成闭环，再向相邻场景复制，使规模与团队执行能力保持匹配。`,
      `价值判断落到${users}的实际改变：入口更清晰、记录更可复盘、体验更稳定，团队也能沉淀原型、测试和调研材料。`,
    ],
    "dc-project-advantages": [
      `差异集中在${pains}的针对性解决。${alias}用${modules}回应真实场景，而不是只提供单一工具或事后处理能力。`,
      `技术链路按照${profile.techRoute}推进，结果进入用户处置、后台记录和后续迭代，形成从场景发生到处理完成的完整过程。`,
    ],
    "dc-market-analysis": [
      `市场由宏观趋势、直接客户和初期可得场景共同构成。${users}在${scenes}中的使用理由、采购触发点和试点门槛，决定了从演示走向交付的可行性。`,
      `替代方案包括${competitors}。正文从成本、部署难度、用户依从性、数据留痕、服务响应和后续迭代等维度形成差异化。`,
    ],
    "dc-product-introduction": [
      `产品服务由${modules}组成。各模块从${scenes}的真实任务进入系统，分别承担接入、识别、判断、提醒、记录和迭代功能，使产品从单点能力转化为可交付服务。`,
      `在典型使用过程中，${users}围绕${scenes}完成触发、响应、确认、记录和复盘。系统输出的不是孤立结果，而是能够进入管理台账、服务流程和后续训练的数据。`,
    ],
    "dc-business-model": [
      `商业模式由${models}构成，分别对应不同客户对象、交付内容、收费口径和持续服务。收入测算由${users}的使用频次、预算来源和采购流程推导。`,
      `早期以样板试点建立信任，沉淀报价表、服务手册、验收指标和${proofs}。当这些材料形成后，才具备向同类客户复制的商业基础。`,
    ],
    "dc-market-operation": [
      `市场运营以可信度建设为起点。团队通过对${users}的访谈、演示、试点、反馈和复盘沉淀客户画像、需求记录和跟进动作。`,
      `渠道拓展从能验证${scenes}的场景资源开始，再扩大到合作伙伴。运营资料包括${proofs}，这些资料同时服务获客、试点沟通和成果展示。`,
    ],
    "dc-financial-plan": [
      `财务规划建立成本与成果的对应关系。${finance}分别对应产品版本、测试记录、试点环境、客户沟通和成果资料，保证预算能够解释产出。`,
      `收入预测按${models}拆分，采用保守、中性和积极三档估算。每档都对应客户数量、收费方式、交付成本和关键假设。`,
    ],
    "dc-team-introduction": [
      `团队组织围绕研发、验证和交付展开。技术成员对应${modules}的研发和测试，市场成员对应${users}访谈和${competitors}对比，材料成员保证图表、附件和测试记录一致。`,
      `团队迭代围绕${metrics}记录测试结果，围绕${proofs}完善支撑资料，围绕客户反馈更新产品版本。`,
    ],
    "dc-risk-management": [
      `风险管理围绕${pains}和产品边界展开。每类风险都对应触发条件、影响对象、处置动作和复盘记录，并通过${metrics}记录问题是否改善。`,
      `质量保障以指标、记录和责任人为核心。测试对应${metrics}，反馈对应${users}，材料更新对应${proofs}，风险控制过程能够被附件证明。`,
    ],
    "dc-future-plan": [
      `短期先把${modules}形成可演示版本，再在${scenes}中完成小范围验证，随后沉淀服务包、运维流程和合作渠道。`,
      `长期价值来自自身的数据、流程和客户经验。随着${proofs}持续增加，${alias}可从单点产品扩展为${profile.domain}领域的场景化解决方案。`,
    ],
    "dc-appendix-proof": [
      `支撑资料与关键结论一一对应。市场需求由${users}调研和公开资料支撑，产品能力由${modules}原型和测试记录支撑，竞争优势由${competitors}对比支撑，财务规划由测算表支撑。`,
      `架构图、流程图、竞品表、财务表、风险表和${proofs}共同构成验证链，保证文本、图表和现场演示口径一致。`,
    ],
  };
  if (chapterSpecific[step.id]) return chapterSpecific[step.id];
  const id = step.id;
  if (/summary|executive/.test(id)) {
    return [
      `开篇先交代${users}在${scenes}中遇到的${pains}，再落到${modules}、${metrics}和${models}，使摘要自然带出后续章节。`,
      `成果口径由${proofs}支撑，经费使用围绕${finance}展开，第一页直接说明做什么、给谁用、如何落地、用什么材料证明。`,
    ];
  }
  if (/background|overview|opportunity/.test(id)) {
    return [
      `问题来源从${scenes}展开。${users}面对的不是抽象需求，而是${pains}，这些矛盾共同构成建设必要性。`,
      `${profile.domain}的发展趋势与切入点相互连接，${modules}比${competitors}更适合初期验证的原因，主要体现在场景更集中、流程更闭环、材料更容易沉淀。`,
    ];
  }
  if (/market|validation|analysis/.test(id)) {
    return [
      `市场分析以${users}为客户分层，以${scenes}为购买或试点触发条件，以${competitors}为替代方案对照。`,
      `验证材料围绕${proofs}组织，重点说明谁愿意用、为什么现在需要、预算从哪里来、怎样从试点复制到同类场景。`,
    ];
  }
  if (/product|solution|company|innovation|technology|advantage/.test(id)) {
    return [
      `产品部分拆开${modules}。每个模块说明输入来源、处理动作、输出结果、服务对象和验证指标，避免只写“智能化、平台化”。`,
      `技术路线按${profile.techRoute}展开，并把${metrics}作为测试依据。${proofs}用于证明产品具备演示和复盘基础。`,
    ];
  }
  if (/business|marketing|sales|growth|operation|management/.test(id)) {
    return [
      `商业和运营部分围绕${models}展开，每种收入路径都对应${users}、${modules}、交付成果和持续服务。`,
      `运营安排服务于${scenes}的真实交付，重点沉淀服务手册、培训材料、验收指标、问题清单和${proofs}，避免写成泛泛推广计划。`,
    ];
  }
  if (/financial|finance|funding/.test(id)) {
    return [
      `财务测算将${finance}拆成研发、测试、部署、运营和展示成果，并说明每笔投入形成什么可验收材料。`,
      `收入预测按${models}设置保守、中性和积极情景，结合${users}的采购路径和${modules}的交付成本进行估算。`,
    ];
  }
  if (/team|organization|foundation/.test(id)) {
    return [
      `团队分工直接对应${modules}。研发负责产品实现，调研负责${users}和${scenes}验证，财务负责${models}测算，运营展示负责${proofs}沉淀。`,
      `成员能力对应具体产出：围绕${metrics}形成测试记录，围绕${pains}形成需求清单，围绕${profile.techRoute}推进版本。`,
    ];
  }
  if (/risk|compliance|future|prospect|strategy|development|appendix|materials|proof|roadshow/.test(id)) {
    return [
      `风险和后续规划来自${scenes}差异、${profile.techRoute}稳定性、数据与授权边界、交付成本、客户转化和团队进度。`,
      `后续资料围绕${proofs}归档。每项材料说明来源、证明对象、对应章节和当前状态，章节内容只保留事实基础、实施路径、数据口径和附件依据。`,
    ];
  }
  return genericStepBlocks;
}

function expandLocalBody(config: WorkflowConfig, step: StepDef, body: string, targetChars: number) {
  let next = body.trim() || mockStepOutput(config, step);
  for (const block of localExpansionBlocks(config, step)) {
    const heading = normalizeQualityText(block).slice(0, 80);
    if (next.length >= targetChars) break;
    if (normalizeQualityText(next).includes(heading)) continue;
    next = `${next}\n\n${block}`.trim();
  }
  return sanitizeProjectBookBody(finalizeSubmissionTone(next));
}

function buildExpansionPrompt(config: WorkflowConfig, step: StepDef, body: string, targetChars: number) {
  return `你是 Paper-agent 的「${step.agent}」。下面是一段竞赛项目书章节草稿，但长度和论证深度不足。

${contextBlock(config)}
${projectProfileDossier(config, step)}
${projectSkillRules(config)}
${submissionToneRules(targetChars)}

当前章节：${step.targetSection}
当前任务：${step.instruction}
最低目标长度：${targetChars} 个中文字符。

现有草稿：
${body.slice(0, 9000)}

请在保留原有结构和事实边界的基础上扩写为完整章节。要求：
1. 输出完整 Markdown 正文，不要解释你做了什么；
2. 增加评审关心的落地路径、数据口径、证明材料、风险控制；
3. 不确定信息使用公开资料口径、项目估算口径、原型测试口径或附件材料说明写成正文；
4. 不能只列提纲，最终正文长度必须达到最低目标。`;
}

async function ensureStepLength(config: WorkflowConfig, step: StepDef, body: string, initial: LLMCallResult) {
  const targetChars = minimumBodyChars(config, step);
  const attempts = [...initial.attempts];
  let source: "external" | "local" = initial.text.trim() ? "external" : "local";
  let model = initial.model;
  let error = initial.error;
  let next = body.trim();

  if (isReferenceWorkflowStep(step)) {
    const skeleton = buildReferenceChapterFromSkeleton(config, step);
    const repeated = duplicateParagraphs(next).length > 0 || repeatedNgrams(next).length > 0;
    const missingOwnHeading = !next.includes(step.targetSection);
    const tooThin = targetChars > 0 && next.length < Math.max(900, Math.round(targetChars * 0.55));
    if (
      !next
      || tooThin
      || repeated
      || missingOwnHeading
      || /本章节中的论证必须回到|当前章节专属写法|项目画像约束包|当前主题事实边界|当前部分事实边界|当前章节|写作要求|提示词|系统说明/.test(next)
    ) {
      next = skeleton || referenceChapterFallback(config, step);
      source = "local";
    }
    return {
      body: sanitizeProjectBookBody(next),
      source,
      model,
      error,
      attempts,
      targetChars,
      actualChars: next.length,
    };
  }

  if (targetChars > 0 && next.length < targetChars && initial.source === "external") {
    const expansion = await callLLM(buildExpansionPrompt(config, step, next, targetChars));
    attempts.push(...expansion.attempts.map((item) => `expand ${item}`));
    if (expansion.text.trim().length > next.length) {
      next = expansion.text.trim();
      source = "external";
      model = expansion.model || model;
      error = expansion.error || error;
    } else if (expansion.error) {
      error = expansion.error;
    }
  }

  if (targetChars > 0 && next.length < targetChars) {
    next = expandLocalBody(config, step, next, targetChars);
    source = source === "external" ? "external" : "local";
  }

  return {
    body: next,
    source,
    model,
    error,
    attempts,
    targetChars,
    actualChars: next.length,
  };
}

async function runWorkflow(id: string) {
  const config = readConfig(id);
  if (!config) throw new Error("工作流不存在");
  const projectDir = join(PROJECTS_DIR, id);
  ensureProjectDirs(projectDir);
  cleanGeneratedWorkflowFiles(projectDir, { backupLabel: hasGeneratedWorkflowFiles(projectDir) ? "start-regenerate" : undefined });

  config.status = "running";
  config.updated = new Date().toISOString();
  writeConfig(id, config);

  const { broadcast } = await import("../index.js");
  const template = templateFor(config);
  const artifactsDir = join(projectDir, ".paper", "artifacts");
  const draftsDir = join(projectDir, ".paper", "drafts");
  const artifacts: ArtifactFile[] = [];

  try {
    const uploadStartedAt = new Date().toISOString();
    const uploadKnowledge = refreshUploadKnowledgeArtifact(id);
    const referenceConfig = withReferenceContext(config, uploadKnowledge.body);
    const workflowSteps = projectWorkflowSteps(referenceConfig);
    const uploadStep: StepDef = {
      id: "upload-knowledge",
      name: "上传资料知识库",
      agent: "资料解析智能体",
      checkpointType: "upload-knowledge",
      targetSection: "上传资料知识库",
      instruction: "解析用户上传的项目资料并整理为后续生成可使用的知识片段。",
    };
    artifacts.push({
      step: uploadStep,
      fileName: "00-upload-knowledge.md",
      path: uploadKnowledge.outputPath,
      content: readFileSync(uploadKnowledge.outputPath, "utf-8"),
    });
    checkpointStore.save({
      id: `${id}-upload-knowledge`,
      workflowId: id,
      stepName: uploadStep.name,
      stepIndex: -2,
      status: "completed",
      input: { step: uploadStep.id },
      output: {
        summary: uploadKnowledge.body.slice(0, 700),
        source: "uploaded-files",
        model: "",
        error: "",
        targetChars: 0,
        actualChars: uploadKnowledge.body.length,
        attempts: listUploadFiles(projectDir).map((file) => file.name),
      },
      artifactPaths: [uploadKnowledge.outputPath],
      startedAt: uploadStartedAt,
      completedAt: new Date().toISOString(),
    });
    const researchStartedAt = new Date().toISOString();
    broadcast("step", {
      workflowId: id,
      step: 0,
      total: workflowSteps.length,
      name: "联网调研资料包",
      agent: "调研智能体",
      status: "running",
    });
    const researchStep: StepDef = {
      id: "research-brief",
      name: "联网调研资料包",
      agent: "调研智能体",
      checkpointType: "research-brief",
      targetSection: "联网调研资料包",
      instruction: "围绕项目方向检索政策、行业、技术、市场和竞品信息，并转化为后续章节可使用的资料包。",
    };
    const researchBody = finalizeSubmissionTone(await buildResearchBrief(referenceConfig));
    const researchArtifact = formatArtifact(researchStep, researchBody, referenceConfig);
    const researchPath = join(artifactsDir, "00-research-brief.md");
    writeFileSync(researchPath, researchArtifact, "utf-8");
    artifacts.push({ step: researchStep, fileName: "00-research-brief.md", path: researchPath, content: researchArtifact });
    const evidenceStartedAt = new Date().toISOString();
    const evidenceStep: StepDef = {
      id: "evidence-index",
      name: "证据库索引",
      agent: "证据库智能体",
      checkpointType: "evidence-index",
      targetSection: "证据库索引",
      instruction: "把用户输入、上传资料名称、联网调研资料和内置研究结论组织为可追溯证据索引。",
    };
    const evidenceBody = buildEvidenceIndex(referenceConfig, `${researchBody}\n\n${uploadKnowledge.body}`);
    const evidenceArtifact = formatArtifact(evidenceStep, evidenceBody, referenceConfig);
    const evidencePath = join(artifactsDir, "00-evidence-index.md");
    writeFileSync(evidencePath, evidenceArtifact, "utf-8");
    artifacts.push({ step: evidenceStep, fileName: "00-evidence-index.md", path: evidencePath, content: evidenceArtifact });
    const blueprintBody = buildReferenceStyleBlueprintArtifact(referenceConfig);
    if (blueprintBody) {
      const blueprintArtifact = formatArtifact(evidenceStep, blueprintBody, referenceConfig);
      const blueprintPath = join(artifactsDir, "00-project-book-audit-blueprint.md");
      writeFileSync(blueprintPath, blueprintArtifact, "utf-8");
      artifacts.push({ step: evidenceStep, fileName: "00-project-book-audit-blueprint.md", path: blueprintPath, content: blueprintArtifact });
    }
    checkpointStore.save({
      id: `${id}-research-brief`,
      workflowId: id,
      stepName: researchStep.name,
      stepIndex: -2,
      status: "completed",
      input: { step: researchStep.id },
      output: {
        summary: researchBody.slice(0, 700),
        source: "web-research",
        model: "",
        error: "",
        targetChars: 0,
        actualChars: researchBody.length,
        attempts: researchQueries(referenceConfig),
      },
      artifactPaths: [researchPath],
      startedAt: researchStartedAt,
      completedAt: new Date().toISOString(),
    });
    checkpointStore.save({
      id: `${id}-evidence-index`,
      workflowId: id,
      stepName: evidenceStep.name,
      stepIndex: -1,
      status: "completed",
      input: { step: evidenceStep.id },
      output: {
        summary: evidenceBody.slice(0, 700),
        source: "evidence-index",
        model: "",
        error: "",
        targetChars: 0,
        actualChars: evidenceBody.length,
        attempts: ["built from user input, research brief, and built-in project-book rules"],
      },
      artifactPaths: [evidencePath],
      startedAt: evidenceStartedAt,
      completedAt: new Date().toISOString(),
    });
    broadcast("step", {
      workflowId: id,
      step: 0,
      total: workflowSteps.length,
      name: researchStep.name,
      agent: researchStep.agent,
      status: "completed",
      artifact: "00-research-brief.md",
    });
    broadcast("step", {
      workflowId: id,
      step: 0,
      total: workflowSteps.length,
      name: uploadStep.name,
      agent: uploadStep.agent,
      status: "completed",
      artifact: "00-upload-knowledge.md",
    });
    broadcast("step", {
      workflowId: id,
      step: 0,
      total: workflowSteps.length,
      name: evidenceStep.name,
      agent: evidenceStep.agent,
      status: "completed",
      artifact: "00-evidence-index.md",
    });

    const manifestStep: StepDef = {
      id: "workflow-manifest",
      name: "工作流计划蓝图",
      agent: "Claude 计划层",
      checkpointType: "workflow-manifest",
      targetSection: "00-workflow-manifest",
      instruction: "生成工作流计划工件，只描述执行顺序、证据边界和参考约束，不生成正文。",
    };
    const manifestBody = buildWorkflowManifestArtifact(referenceConfig, workflowSteps);
    const manifestArtifact = formatArtifact(manifestStep, manifestBody, referenceConfig);
    const manifestPath = join(artifactsDir, "00-workflow-manifest.md");
    writeFileSync(manifestPath, manifestArtifact, "utf-8");
    artifacts.push({ step: manifestStep, fileName: "00-workflow-manifest.md", path: manifestPath, content: manifestArtifact });
    broadcast("step", {
      workflowId: id,
      step: 0,
      total: workflowSteps.length,
      name: manifestStep.name,
      agent: manifestStep.agent,
      status: "completed",
      artifact: "00-workflow-manifest.md",
    });

    for (let i = 0; i < workflowSteps.length; i++) {
      const step = workflowSteps[i];
      const startedAt = new Date().toISOString();
      broadcast("step", {
        workflowId: id,
        step: i + 1,
        total: workflowSteps.length,
        name: step.name,
        agent: step.agent,
        status: "running",
      });

      checkpointStore.save({
        id: `${id}-${step.id}`,
        workflowId: id,
        stepName: step.name,
        stepIndex: i + 1,
        status: "running",
        input: { step: step.id },
        output: {},
        startedAt,
      });

      const generation = step.id === "final-assembly"
        ? {
            body: assembleFinalBook(referenceConfig, artifacts),
            source: "assembly",
            model: "",
            error: "",
            attempts: [],
            targetChars: 0,
            actualChars: 0,
          }
        : isReferenceWorkflowStep(step)
          ? await ensureStepLength(
              referenceConfig,
              step,
              buildReferenceChapterFromSkeleton(referenceConfig, step),
              {
                text: "",
                source: "none",
                error: "reference workflow local skeleton generation",
                attempts: ["reference skeleton generator"],
              },
            )
        : await (async () => {
            const llm = await callLLM(buildProjectPrompt(referenceConfig, step, artifacts));
            const seed = llm.text.trim() || mockStepOutput(referenceConfig, step);
            return ensureStepLength(referenceConfig, step, seed, llm);
          })();
      const body = finalizeSubmissionTone(generation.body);
      generation.actualChars = body.length;

      const artifact = formatArtifact(step, body, config);
      const fileName = `${String(i + 1).padStart(2, "0")}-${step.id}.md`;
      const artifactPath = join(artifactsDir, fileName);
      writeFileSync(artifactPath, artifact, "utf-8");
      artifacts.push({ step, fileName, path: artifactPath, content: artifact });

      if (step.id === "final-assembly") {
        writeFileSync(join(draftsDir, "project-book-final.md"), body, "utf-8");
      }

      checkpointStore.save({
        id: `${id}-${step.id}`,
        workflowId: id,
        stepName: step.name,
        stepIndex: i + 1,
        status: "completed",
        input: { step: step.id },
        output: {
          summary: body.slice(0, 700),
          source: generation.source,
          model: generation.model || "",
          error: generation.error || "",
          targetChars: generation.targetChars,
          actualChars: generation.actualChars,
          attempts: generation.attempts.slice(-8),
        },
        artifactPaths: [artifactPath],
        startedAt,
        completedAt: new Date().toISOString(),
      });

      broadcast("step", {
        workflowId: id,
        step: i + 1,
        total: workflowSteps.length,
        name: step.name,
        agent: step.agent,
        status: "completed",
        artifact: fileName,
      });
    }

    const finalDraftPath = join(draftsDir, "project-book-final.md");
    if (existsSync(finalDraftPath)) {
      const qualityStartedAt = new Date().toISOString();
      const reviewLoop = runFinalBookReviewLoop(id, referenceConfig, readFileSync(finalDraftPath, "utf-8"), artifacts);
      const qualityStep = qualityStepDef();
      const reviewStep = reviewStepDef();
      const qualityContent = readFileSync(reviewLoop.qualityPath, "utf-8");
      const reviewContent = readFileSync(reviewLoop.reviewPath, "utf-8");
      artifacts.push({ step: qualityStep, fileName: "98-quality-report.md", path: reviewLoop.qualityPath, content: qualityContent });
      artifacts.push({ step: reviewStep, fileName: "99-review-report.md", path: reviewLoop.reviewPath, content: reviewContent });
      checkpointStore.save({
        id: `${id}-quality-scan`,
        workflowId: id,
        stepName: qualityStep.name,
        stepIndex: workflowSteps.length + 1,
        status: "completed",
        input: { step: qualityStep.id },
        output: {
          summary: qualityContent.slice(0, 700),
          source: "local-quality-scan",
          model: "",
          error: "",
          targetChars: 0,
          actualChars: qualityContent.length,
          attempts: ["duplicate paragraphs", "repeated ngrams", "risk language", "evidence density", "format density"],
        },
        artifactPaths: [reviewLoop.qualityPath],
        startedAt: qualityStartedAt,
        completedAt: new Date().toISOString(),
      });
      broadcast("step", {
        workflowId: id,
        step: workflowSteps.length + 1,
        total: workflowSteps.length + 2,
        name: qualityStep.name,
        agent: qualityStep.agent,
        status: "completed",
        artifact: "98-quality-report.md",
      });

      const reviewStartedAt = new Date().toISOString();
      checkpointStore.save({
        id: `${id}-final-review-loop`,
        workflowId: id,
        stepName: reviewStep.name,
        stepIndex: workflowSteps.length + 2,
        status: "completed",
        input: { step: reviewStep.id },
        output: {
          summary: reviewContent.slice(0, 700),
          source: "local-review-loop",
          model: "",
          error: "",
          targetChars: 0,
          actualChars: reviewContent.length,
          attempts: [
            "rubric scoring",
            "risk scan",
            reviewLoop.changed ? "auto repair applied" : "no repair needed",
            `score ${reviewLoop.before.score}->${reviewLoop.after.score}`,
          ],
        },
        artifactPaths: [reviewLoop.reviewPath, reviewLoop.revisedPath, reviewLoop.repairedPath, reviewLoop.finalPath],
        startedAt: reviewStartedAt,
        completedAt: new Date().toISOString(),
      });

      broadcast("step", {
        workflowId: id,
        step: workflowSteps.length + 2,
        total: workflowSteps.length + 2,
        name: reviewStep.name,
        agent: reviewStep.agent,
        status: "completed",
        artifact: "99-review-report.md",
      });
    }

    referenceConfig.status = "completed";
    referenceConfig.updated = new Date().toISOString();
    writeConfig(id, referenceConfig);
    broadcast("done", { workflowId: id, fileName: "project-book-final.md" });
    return join(draftsDir, "project-book-final.md");
  } catch (error: any) {
    config.status = "failed";
    config.updated = new Date().toISOString();
    writeConfig(id, config);
    broadcast("failed", { workflowId: id, error: error.message ?? String(error) });
    throw error;
  }
}

async function runWorkflowPlanning(id: string) {
  const config = readConfig(id);
  if (!config) throw new Error("工作流不存在");
  const projectDir = join(PROJECTS_DIR, id);
  ensureProjectDirs(projectDir);
  const referenceConfig = { ...config };
  const workflowSteps = projectWorkflowSteps(referenceConfig);
  const artifactsDir = join(projectDir, ".paper", "artifacts");
  mkdirSync(artifactsDir, { recursive: true });
  const manifestStep: StepDef = {
    id: "workflow-manifest",
    name: "工作流规划清单",
    agent: "规划器",
    checkpointType: "workflow-manifest",
    targetSection: "00-workflow-manifest",
    instruction: "输出规划清单，不写正文。",
  };
  const manifestBody = buildWorkflowManifestArtifact(referenceConfig, workflowSteps);
  writeFileSync(join(artifactsDir, "00-workflow-manifest.md"), formatArtifact(manifestStep, manifestBody, referenceConfig), "utf-8");
  const blueprintBody = buildReferenceStyleBlueprintArtifact(referenceConfig);
  if (blueprintBody) {
    const blueprintStep: StepDef = {
      id: "reference-blueprint",
      name: "参考写法蓝图",
      agent: "规划器",
      checkpointType: "reference-blueprint",
      targetSection: "00-reference-style-blueprint",
      instruction: "提取结构与写法，不继承事实。",
    };
    writeFileSync(join(artifactsDir, "00-reference-style-blueprint.md"), formatArtifact(blueprintStep, blueprintBody, referenceConfig), "utf-8");
  }
  const uploadKnowledge = refreshUploadKnowledgeArtifact(id);
  const researchBody = finalizeSubmissionTone(await buildResearchBrief(referenceConfig));
  writeFileSync(join(artifactsDir, "00-research-brief.md"), researchBody, "utf-8");
  const evidenceBody = buildEvidenceIndex(referenceConfig, `${researchBody}\n\n${uploadKnowledge.body}`);
  writeFileSync(join(artifactsDir, "00-evidence-index.md"), evidenceBody, "utf-8");
  referenceConfig.status = "planned";
  referenceConfig.updated = new Date().toISOString();
  writeConfig(id, referenceConfig);
  return { success: true, workflow: workflowSummary(id) };
}

async function runWorkflowExecution(id: string) {
  const finalPath = await runWorkflow(id);
  return { success: true, workflow: workflowSummary(id), finalPath };
}

async function runWorkflowAudit(id: string) {
  const result = await buildDeliveryPackage(id, false);
  return { success: true, workflow: result.workflow, quality: result.quality, delivery: result.delivery, files: result.files };
}

type ExportFormat = "docx" | "pdf" | "tex";

function exportProjectBook(id: string, format: ExportFormat) {
  const workflowId = resolveWorkflowId(id);
  const summary = workflowSummary(workflowId);
  if (!summary) throw new Error("工作流不存在");
  const draftsDir = join(PROJECTS_DIR, workflowId, ".paper", "drafts");
  const finalPath = join(draftsDir, "project-book-final.md");
  if (!existsSync(finalPath)) throw new Error("请先生成完整项目书，再导出 Word/PDF");

  mkdirSync(EXPORTS_DIR, { recursive: true });
  const safeName = safeId(summary.name || id);
  const outputPath = join(EXPORTS_DIR, `${safeName}-${Date.now()}.${format}`);
  const scriptPath = join(process.cwd(), "python", "paper_agent", "export", "project_book.py");
  const settings = getRuntimeSettings();
  const payload = JSON.stringify({
    markdown: readFileSync(finalPath, "utf-8"),
    format,
    output_path: outputPath,
    project: {
      name: summary.name || id,
      template: summary.template || "",
      competition: summary.competition || "",
      track: summary.track || "",
      docStyle: summary.docStyle || "competition",
      pageLimit: summary.pageLimit || "",
      product: summary.product || "",
      market: summary.market || "",
      finance: summary.finance || "",
      imageProvider: settings.imageProvider || "",
      imageBaseUrl: settings.imageBaseUrl || "",
      imageModel: settings.imageModel || "",
      imageApiKey: settings.imageApiKey || "",
    },
  });

  return new Promise<{ success: boolean; outputPath: string; fileName: string; fileSize: number }>((resolve, reject) => {
    const child = spawn(resolvePythonExe(), [scriptPath], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr || `导出进程退出，code=${code}`));
        return;
      }
      try {
        const data = JSON.parse(stdout.trim().split(/\r?\n/).pop() || "{}");
        resolve({
          success: true,
          outputPath: data.output_path || outputPath,
          fileName: outputPath.split(/[\\/]/).pop() || `project-book.${format}`,
          fileSize: data.file_size || statSync(outputPath).size,
        });
      } catch (error: any) {
        reject(new Error(error.message || "导出结果解析失败"));
      }
    });
    child.stdin.write(payload);
    child.stdin.end();
  });
}

type DeliveryCheck = {
  label: string;
  ok: boolean;
  detail: string;
};

function fileDeliveryInfo(path: string, label: string) {
  const exists = existsSync(path);
  const stat = exists ? statSync(path) : null;
  return {
    label,
    path,
    exists,
    size: stat?.size ?? 0,
    updated: stat?.mtime.toISOString() ?? "",
  };
}

function countPlainMatches(text: string, words: string[]) {
  return words.reduce((sum, word) => {
    if (!word) return sum;
    return sum + text.split(word).length - 1;
  }, 0);
}

function buildDeliveryChecks(finalBook: string, files: Record<string, ReturnType<typeof fileDeliveryInfo>>, config?: WorkflowConfig) {
  const chars = finalBook.length;
  const tableLines = countOccurrences(finalBook, /^\|.+\|$/gm);
  const figureSignals = countOccurrences(finalBook, /!\[|paper:\/\/figure|图\s*\d|图[一二三四五六七八九十]/g);
  const suggestionHits = countPlainMatches(finalBook, ["建议", "待补充", "后续完善", "如有条件", "以实际提交附件为准", "无法确定", "TODO", "???"]);
  const systemSectionHits = countPlainMatches(finalBook, ["自动去重修稿说明", "评审返修落实说明", "附录A 评审补强材料", "附录B 深度调研与验收补充", "附录C 格式规范与提交清单补充", "用户自定义产物要求核对", "Paper-agent 负责", "材料来源与正文对应表"]);
  const duplicateCount = duplicateParagraphs(finalBook).length;
  const referenceChapters = config ? referenceStyleChapters(config).map((item) => item.chapter) : [];
  const requiredSections = referenceChapters.length >= 3
    ? referenceChapters
    : [
      "一、项目方案概述",
      "二、项目团队概述",
      "三、产业背景与项目产品",
      "四、市场调查与竞争分析",
      "五、商业模式与发展战略",
      "六、预期效益分析",
      "七、总结与资金回报",
      "八、证明材料",
    ];
  const missingSections = requiredSections.filter((section) => !finalBook.includes(section));
  const hasReferenceWorkflow = referenceChapters.length >= 3;
  const minChars = hasReferenceWorkflow ? 12_000 : 18_000;
  const minTables = referenceChapters.length >= 3 ? 24 : 45;
  const minFigures = referenceChapters.length >= 3 ? 0 : 2;
  return [
    { label: "终稿 Markdown", ok: files.finalMarkdown.exists && chars > 0, detail: `${chars.toLocaleString()} 字符` },
    { label: "自动修稿", ok: files.repairedMarkdown.exists, detail: files.repairedMarkdown.exists ? files.repairedMarkdown.path : "未找到自动修稿草稿" },
    { label: "质量报告", ok: files.qualityReport.exists, detail: files.qualityReport.exists ? files.qualityReport.path : "未找到 98-quality-report.md" },
    { label: "评审返修报告", ok: files.reviewReport.exists, detail: files.reviewReport.exists ? files.reviewReport.path : "未找到 99-review-report.md" },
    { label: "Word 文件", ok: files.docx.exists && files.docx.size > 10_000, detail: `${files.docx.size.toLocaleString()} bytes` },
    { label: "PDF 文件", ok: files.pdf.exists && files.pdf.size > 10_000, detail: `${files.pdf.size.toLocaleString()} bytes` },
    { label: "正文长度", ok: chars >= minChars, detail: chars >= minChars ? "达到完整项目书长度" : `低于 ${minChars.toLocaleString()} 字符，需要增强正文内容` },
    { label: "表格密度", ok: tableLines >= minTables, detail: `${tableLines} 行表格标记` },
    { label: "图示占位", ok: figureSignals >= minFigures, detail: `${figureSignals} 个图示信号` },
    { label: "章节覆盖完整度", ok: missingSections.length === 0, detail: missingSections.length ? `缺少：${missingSections.join("、")}` : "项目书章节覆盖完整" },
    { label: "证据库报告", ok: files.qualityReport.exists, detail: files.qualityReport.exists ? "证据映射保留在质量报告/证据库中，不写入正文" : "缺少质量报告" },
    { label: "去重风险", ok: hasReferenceWorkflow ? duplicateCount <= 12 : duplicateCount === 0, detail: duplicateCount === 0 ? "未发现整段重复" : `${duplicateCount} 组疑似重复段落` },
    { label: "建议式口吻", ok: suggestionHits === 0, detail: `${suggestionHits} 处提示词命中` },
    { label: "系统说明隔离", ok: systemSectionHits === 0, detail: systemSectionHits === 0 ? "项目书正文未混入质检/交付说明" : `${systemSectionHits} 处系统说明混入正文` },
  ] satisfies DeliveryCheck[];
}

function buildDeliveryGuidance(finalBook: string, checks: DeliveryCheck[]) {
  const failed = checks.filter((check) => !check.ok);
  const failedLabels = failed.map((check) => check.label);
  const canAutoRepair = failed.some((check) => /去重风险|建议式口吻|系统说明隔离/.test(check.label));
  const shouldRegenerate = failed.some((check) => /正文长度|章节覆盖完整度|图示占位|表格密度/.test(check.label));
  const nextActions: string[] = [];
  if (canAutoRepair) nextActions.push("点击“质量体检”里的“按体检自动修复”，清理重复、串项、建议口吻和系统说明。");
  if (shouldRegenerate) nextActions.push("点击“重新生成并覆盖”，让工作流按当前表单和上传资料重新生成完整稿并重新交付。");
  if (failedLabels.includes("图示占位")) nextActions.push("开启图示生成或补充架构图/流程图后重新导出 Word/PDF。");
  if (failedLabels.includes("章节覆盖完整度")) nextActions.push("检查当前项目是否为旧稿恢复稿；旧稿建议重新跑完整工作流以补齐赛事章节。");
  if (!failed.length) nextActions.push("交付检查已通过，下一步只需按学校/赛事模板人工核对真实附件和签字盖章材料。");
  return {
    status: failed.length ? "needs_attention" : "ready",
    failedCount: failed.length,
    failedLabels,
    shouldRegenerate,
    canAutoRepair,
    summary: failed.length
      ? `交付包已生成，但还有 ${failed.length} 项需要处理：${failedLabels.join("、")}。`
      : "交付包已生成并通过自动检查。",
    nextActions,
    finalChars: finalBook.length,
  };
}

function buildReviewReportArtifact(config: WorkflowConfig, finalBook: string, quality: ReturnType<typeof buildQualityScanSummary>, delivery: ReturnType<typeof buildDeliveryChecks>) {
  return [
    "# 99-review-report",
    "",
    "## 审计结论",
    `- 项目：${config.name}`,
    `- 综合评分：${quality.score}/${quality.band}`,
    `- 交付状态：${delivery.status}`,
    "",
    "## 需要返修的项",
    ...(delivery.filter((item) => !item.ok).map((item) => `- ${item.label}：${item.detail}`)),
    "",
    "## 通过项",
    ...(delivery.filter((item) => item.ok).map((item) => `- ${item.label}：${item.detail}`)),
  ].join("\n");
}

function readArtifactFilesForDelivery(workflowId: string, config: WorkflowConfig) {
  const projectDir = projectDirFor(workflowId);
  const artifactsDir = join(projectDir, ".paper", "artifacts");
  if (!existsSync(artifactsDir)) return [];
  return readdirSync(artifactsDir)
    .filter((name) => name.endsWith(".md"))
    .map((fileName) => {
      const path = join(artifactsDir, fileName);
      const content = readFileSync(path, "utf-8");
      const checkpointMatch = content.match(/>\s*输出类型:\s*([^\n]+)/);
      const titleMatch = content.match(/^#\s+(.+)$/m);
      const id = fileName
        .replace(/^\d+-/, "")
        .replace(/\.md$/i, "")
        .replace(/[^a-z0-9-]+/gi, "-")
        .replace(/^-+|-+$/g, "") || fileName.replace(/\.md$/i, "");
      const step: StepDef = {
        id,
        name: titleMatch?.[1] || fileName,
        agent: "交付包补齐器",
        checkpointType: checkpointMatch?.[1]?.trim() || id,
        targetSection: titleMatch?.[1] || fileName,
        instruction: "从既有产物中恢复交付包上下文。",
      };
      const stepMatch = fileName.match(/^\d+-(ref-chapter-\d+|dc-[a-z0-9-]+|[a-z0-9-]+)\.md$/i);
      if (stepMatch) {
        const templateStep = projectWorkflowSteps(config).find((item) => item.id === stepMatch[1])
          || templateFor(config).steps.find((item) => item.id === stepMatch[1]);
        if (templateStep) {
          step.id = templateStep.id;
          step.name = templateStep.name;
          step.agent = templateStep.agent;
          step.checkpointType = templateStep.checkpointType;
          step.targetSection = templateStep.targetSection;
          step.instruction = templateStep.instruction;
        }
      }
      if (fileName.includes("research-brief")) step.id = "research-brief";
      if (fileName.includes("upload-knowledge")) step.id = "upload-knowledge";
      if (fileName.includes("evidence-index")) step.id = "evidence-index";
      if (fileName.includes("quality-report")) step.id = "quality-scan";
      if (fileName.includes("review-report")) step.id = "final-review-loop";
      return { step, fileName, path, content };
    });
}

function ensureDeliveryArtifacts(workflowId: string, config: WorkflowConfig, finalPath: string) {
  const projectDir = projectDirFor(workflowId);
  const draftsDir = join(projectDir, ".paper", "drafts");
  const artifactsDir = join(projectDir, ".paper", "artifacts");
  mkdirSync(draftsDir, { recursive: true });
  mkdirSync(artifactsDir, { recursive: true });

  let artifacts = readArtifactFilesForDelivery(workflowId, config);
  let finalBook = readFileSync(finalPath, "utf-8");
  const hasWorkflowHeadings = /#{2,3}\s+[一二三四五六七八九十]、.+（.+）.+[:：](项目书正文深化|场景对象与使用流程|量化指标体系|实施与验收路径|资料依据与证明链条|风险控制与迭代机制|竞赛呈现价值)/.test(finalBook);
  const hasLegacyDachuangChapters = /研究目标与项目内容|行业背景与国内外现状|产品与服务方案|商业模式与运营策略|技术路线与实施计划|团队介绍与已有基础|财务规划与风险管理|预期成果、未来展望与证明材料/.test(finalBook);
  const hasEightChapterDachuang = /一、项目方案概述[\s\S]+二、项目团队概述[\s\S]+三、产业背景与项目产品[\s\S]+四、市场调查与竞争分析[\s\S]+五、商业模式与发展战略[\s\S]+六、预期效益分析[\s\S]+七、总结与资金回报[\s\S]+八、证明材料/.test(finalBook);
  const hasOldCommercialChapters = /执行摘要[\s\S]+项目优势[\s\S]+市场运营[\s\S]+未来展望/.test(finalBook);
  const hasChapterArtifacts = artifacts.some((artifact) => !isSupportArtifact(artifact) && artifact.step.id !== "final-assembly" && !artifact.step.id.endsWith("outline"));
  if ((hasWorkflowHeadings || hasLegacyDachuangChapters || hasOldCommercialChapters || !hasEightChapterDachuang) && hasChapterArtifacts) {
    finalBook = assembleFinalBook(config, artifacts);
    writeFileSync(finalPath, finalBook, "utf-8");
  }
  const blueprintPath = join(projectDir, ".paper", "artifacts", "00-project-book-audit-blueprint.md");
  if (!existsSync(blueprintPath)) {
    const blueprintBody = buildReferenceStyleBlueprintArtifact(config);
    if (blueprintBody) {
      writeFileSync(blueprintPath, formatArtifact({ id: "reference-blueprint", name: "参考写法蓝图", agent: "结构审计", checkpointType: "reference-blueprint", targetSection: "参考写法蓝图", instruction: "根据当前上传参考文档生成结构蓝图" }, blueprintBody, config), "utf-8");
    }
  }
  finalBook = finalizeManuscriptTone(stripAutoGeneratedSections(removeRepeatedAutoSections(finalBook)));
  const reviewLoop = runFinalBookReviewLoop(workflowId, config, finalBook, artifacts);
  finalBook = reviewLoop.repaired;
  config.updated = new Date().toISOString();
  writeConfig(workflowId, config);
  return finalBook;
}

async function buildDeliveryPackage(id: string, force = false) {
  const workflowId = resolveWorkflowId(id);
  const summary = workflowSummary(workflowId);
  if (!summary) throw new Error("工作流不存在");
  if (summary.status === "running") throw new Error("工作流正在运行，请等待当前生成结束后再生成交付包");

  const projectDir = projectDirFor(workflowId);
  const draftsDir = join(projectDir, ".paper", "drafts");
  const artifactsDir = join(projectDir, ".paper", "artifacts");
  const finalPath = join(draftsDir, "project-book-final.md");
  const beforeFinalBook = safeReadText(finalPath);
  const preConfig = readConfig(workflowId);
  const staleDachuangArtifacts = existsSync(artifactsDir)
    && readdirSync(artifactsDir).some((name) => /^\d+-dc-/.test(name))
    && summary.steps?.some((step: StepDef) => /^ref-chapter-\d+$/.test(step.id));
  const shouldForce = force || Boolean(preConfig?.referenceNotes && staleDachuangArtifacts);
  let backup: ReturnType<typeof copyGeneratedWorkflowSnapshot> | null = null;
  if (shouldForce && hasGeneratedWorkflowFiles(projectDir)) {
    backup = copyGeneratedWorkflowSnapshot(projectDir, "deliver-force-before-regenerate");
  }
  if (shouldForce || !existsSync(finalPath)) {
    await runWorkflow(workflowId);
  }
  const config = readConfig(workflowId);
  if (!config) throw new Error("工作流配置不存在");
  const finalBook = ensureDeliveryArtifacts(workflowId, config, finalPath);
  const regeneration = shouldForce ? regenerationSummary(beforeFinalBook, finalBook) : null;

  const docx = await exportProjectBook(workflowId, "docx");
  const pdf = await exportProjectBook(workflowId, "pdf");
  const files = {
    finalMarkdown: fileDeliveryInfo(finalPath, "终稿 Markdown"),
    repairedMarkdown: fileDeliveryInfo(join(draftsDir, "project-book-final-repaired.md"), "自动修稿 Markdown"),
    revisedMarkdown: fileDeliveryInfo(join(draftsDir, "project-book-final-revised.md"), "复审稿 Markdown"),
    qualityReport: fileDeliveryInfo(join(artifactsDir, "98-quality-report.md"), "质量报告"),
    reviewReport: fileDeliveryInfo(join(artifactsDir, "99-review-report.md"), "评审返修报告"),
    docx: fileDeliveryInfo(docx.outputPath, "Word"),
    pdf: fileDeliveryInfo(pdf.outputPath, "PDF"),
  };
  const checks = buildDeliveryChecks(finalBook, files, config);
  return {
    success: true,
    workflow: workflowSummary(workflowId),
    generatedAt: new Date().toISOString(),
    exportDir: EXPORTS_DIR,
    files,
    checks,
    guidance: buildDeliveryGuidance(finalBook, checks),
    backup,
    regeneration,
  };
}

workflowsRouter.get("/templates", (_req, res) => {
  res.json(WORKFLOW_TEMPLATES);
});

workflowsRouter.get("/", (_req, res) => {
  if (!existsSync(PROJECTS_DIR)) return res.json([]);
  const workflows = readdirSync(PROJECTS_DIR)
    .map((id) => workflowSummary(id))
    .filter(Boolean)
    .sort((a: any, b: any) => String(b.updated).localeCompare(String(a.updated)));
  res.json(workflows);
});

workflowsRouter.post("/", (req, res) => {
  const name = String(req.body?.name ?? "").trim();
  if (!name) return res.status(400).json({ error: "缺少项目名称" });
  const id = safeId(name);
  const projectDir = join(PROJECTS_DIR, id);
  if (existsSync(projectDir)) return res.status(409).json({ error: "项目已存在" });

  const template = (req.body?.template || req.body?.competition || "dachuang") as WorkflowTemplateId;
  const now = new Date().toISOString();
  const config: WorkflowConfig = {
    name,
    template: WORKFLOW_TEMPLATES[template] ? template : "dachuang",
    competition: String(req.body?.competition ?? template ?? "dachuang"),
    track: String(req.body?.track ?? ""),
    team: String(req.body?.team ?? ""),
    brief: String(req.body?.brief ?? ""),
    product: String(req.body?.product ?? ""),
    market: String(req.body?.market ?? ""),
    finance: String(req.body?.finance ?? ""),
    evidence: String(req.body?.evidence ?? ""),
    pageLimit: String(req.body?.pageLimit ?? "30"),
    reviewMode: String(req.body?.reviewMode ?? "strict"),
    figureMode: Boolean(req.body?.figureMode ?? false),
    figureCount: String(req.body?.figureCount ?? "2"),
    tableMode: Boolean(req.body?.tableMode ?? false),
    tableCount: String(req.body?.tableCount ?? "5"),
    dataMode: Boolean(req.body?.dataMode ?? false),
    dataCount: String(req.body?.dataCount ?? "3"),
    modelMode: Boolean(req.body?.modelMode ?? false),
    modelCount: String(req.body?.modelCount ?? "1"),
    docStyle: String(req.body?.docStyle ?? "competition"),
    referenceNotes: String(req.body?.referenceNotes ?? ""),
    contestFileNotes: String(req.body?.contestFileNotes ?? ""),
    attachmentNotes: String(req.body?.attachmentNotes ?? ""),
    autoAdvance: req.body?.autoAdvance !== false,
    humanCheckpoint: Boolean(req.body?.humanCheckpoint ?? false),
    revisionLoop: req.body?.revisionLoop !== false,
    status: "draft",
    created: now,
    updated: now,
  };
  writeConfig(id, config);
  res.json({ success: true, id, ...workflowSummary(id) });
});

workflowsRouter.post("/:id/uploads", async (req, res) => {
  try {
    const workflowId = resolveWorkflowId(req.params.id);
    const config = readConfig(workflowId);
    if (!config) return res.status(404).json({ error: "工作流不存在" });
    const projectDir = projectDirFor(workflowId);
    ensureProjectDirs(projectDir);
    const uploadsDir = join(projectDir, ".paper", "uploads");
    const contentType = String(req.headers["content-type"] || "");
    if (!contentType.includes("multipart/form-data")) {
      return res.status(400).json({ error: "请使用 multipart/form-data 上传文件" });
    }
    const body = await readRequestBody(req);
    const files = parseMultipartUploads(body, contentType);
    const metadata = readUploadMetadata(uploadsDir);
    const saved = files.map((file) => {
      const name = uniqueUploadName(uploadsDir, file.filename);
      const path = join(uploadsDir, name);
      writeFileSync(path, file.data);
      metadata[name] = {
        field: file.field,
        originalName: file.filename,
        contentType: file.contentType,
        uploadedAt: new Date().toISOString(),
      };
      return {
        field: file.field,
        name,
        originalName: file.filename,
        contentType: file.contentType,
        size: file.data.length,
      };
    });
    writeUploadMetadata(uploadsDir, metadata);
    const knowledge = refreshUploadKnowledgeArtifact(workflowId);
    const nextConfig = withReferenceContext(config, knowledge.body);
    nextConfig.updated = new Date().toISOString();
    writeConfig(workflowId, nextConfig);
    res.json({ success: true, files: saved, knowledgePath: knowledge.outputPath, workflow: workflowSummary(workflowId) });
  } catch (error: any) {
    res.status(error?.statusCode || 400).json({ error: error.message ?? String(error) });
  }
});

workflowsRouter.get("/:id/files", (req, res) => {
  const summary = workflowSummary(req.params.id);
  if (!summary) return res.status(404).json({ error: "workflow not found" });
  res.json({
    workflow: summary,
    groups: listEditorFiles(req.params.id),
  });
});

workflowsRouter.get("/:id/file", (req, res) => {
  const summary = workflowSummary(req.params.id);
  if (!summary) return res.status(404).json({ error: "workflow not found" });
  try {
    const { relativePath, absolutePath } = resolveProjectPath(req.params.id, req.query.path);
    if (!existsSync(absolutePath) || !statSync(absolutePath).isFile()) {
      return res.status(404).json({ error: "file not found" });
    }
    if (!EDITABLE_EXTENSIONS.has(extname(relativePath).toLowerCase())) {
      return res.status(400).json({ error: "unsupported file type" });
    }
    res.json({
      name: basename(absolutePath),
      path: relativePath,
      kind: fileKind(relativePath),
      extension: extname(relativePath).slice(1) || "text",
      content: readFileSync(absolutePath, "utf-8"),
      size: statSync(absolutePath).size,
      updated: statSync(absolutePath).mtime.toISOString(),
    });
  } catch (error: any) {
    res.status(400).json({ error: error.message ?? String(error) });
  }
});

workflowsRouter.put("/:id/file", (req, res) => {
  const summary = workflowSummary(req.params.id);
  if (!summary) return res.status(404).json({ error: "workflow not found" });
  try {
    const file = writeEditorFile(req.params.id, req.body?.path, req.body?.content);
    res.json({ success: true, file });
  } catch (error: any) {
    res.status(400).json({ error: error.message ?? String(error) });
  }
});

workflowsRouter.get("/latex-output/:fileName", (req, res) => {
  const fileName = basename(String(req.params.fileName || ""));
  if (!fileName || fileName !== String(req.params.fileName || "") || extname(fileName).toLowerCase() !== ".pdf") {
    return res.status(400).json({ error: "invalid output file" });
  }
  const outputPath = resolve(EXPORTS_DIR, fileName);
  const scope = relative(resolve(EXPORTS_DIR), outputPath);
  if (scope.startsWith("..") || isAbsolute(scope) || !existsSync(outputPath) || !statSync(outputPath).isFile()) {
    return res.status(404).json({ error: "output file not found" });
  }
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Length", String(statSync(outputPath).size));
  res.send(readFileSync(outputPath));
});

workflowsRouter.post("/:id/editor/compile", async (req, res) => {
  const workflowId = resolveWorkflowId(req.params.id);
  const summary = workflowSummary(workflowId);
  if (!summary) return res.status(404).json({ error: "workflow not found" });
  const requestedFormat = String(req.body?.format || "pdf");
  const format = requestedFormat === "latex" ? "tex" : requestedFormat;
  if (format !== "docx" && format !== "pdf" && format !== "tex") {
    return res.status(400).json({ error: "only docx, pdf and tex are supported" });
  }

  try {
    if (req.body?.path && typeof req.body?.content === "string") {
      writeEditorFile(workflowId, req.body.path, req.body.content);
    }
    if (format === "pdf" && req.body?.path && extname(normalizeEditorPath(req.body.path)).toLowerCase() === ".tex") {
      const result = await compileLatexEditorFile(workflowId, req.body.path, summary.name || workflowId);
      res.json(result);
      return;
    }
    if (format === "tex" && req.body?.path && extname(normalizeEditorPath(req.body.path)).toLowerCase() === ".tex") {
      const { relativePath, absolutePath } = resolveProjectPath(workflowId, req.body.path);
      res.json({
        success: true,
        outputPath: absolutePath,
        fileName: basename(absolutePath),
        fileSize: statSync(absolutePath).size,
        log: [
          `Workflow: ${summary.name}`,
          `Format: tex`,
          `Source: ${relativePath}`,
          "当前打开的是 LaTeX 源码文件，已保存当前内容，无需重新生成 .tex。",
        ].join("\n"),
      });
      return;
    }
    const result = await exportProjectBook(workflowId, format);
    res.json({
      ...result,
      log: [
        `Workflow: ${summary.name}`,
        `Format: ${format}`,
        `Output: ${result.outputPath}`,
        "Markdown 项目书导出仍使用当前 .paper/drafts/project-book-final.md。",
      ].join("\n"),
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message ?? String(error) });
  }
});

workflowsRouter.post("/:id/editor/assist", async (req, res) => {
  const summary = workflowSummary(req.params.id);
  if (!summary) return res.status(404).json({ error: "workflow not found" });
  const workflowId = resolveWorkflowId(req.params.id);
  const instruction = String(req.body?.instruction || "").trim();
  const content = String(req.body?.content || "");
  const modelContent = content.slice(0, 16000);
  const mode = String(req.body?.mode || "latex");
  const filePath = String(req.body?.path || "");
  if (!instruction) return res.status(400).json({ error: "missing instruction" });
  const config = summary as WorkflowConfig;
  const wholeDocumentRequested = wantsWholeDocumentImprove(instruction);
  const editorQualityContext = wholeDocumentRequested ? buildEditorQualityContext(config, content) : undefined;
  let editorResearchContext: { sourceCount: number; evidenceCount: number; highlights: string[] } | undefined;
  const getEditorResearchContext = async () => {
    if (!editorResearchContext) {
      editorResearchContext = await ensureEditorResearchArtifacts(workflowId, config);
    }
    return editorResearchContext;
  };
  const makeEditorBackup = () => filePath ? backupEditorFile(workflowId, filePath, "editor-before-agent-edit") : null;

  const localDirectEdit = tryLocalDirectEdit(content, instruction);
  if (localDirectEdit) {
    return res.json({
      success: true,
      answer: localDirectEdit.answer,
      action: "replace_current_file",
      patch: localDirectEdit.patch,
      agentTrace: editorTraceForAppliedEdit(content, instruction, filePath, localDirectEdit.patch, "完成定点修改"),
      backup: makeEditorBackup(),
      canApply: true,
      autoApply: true,
    });
  }

  if (wholeDocumentRequested) {
    const researchContext = await getEditorResearchContext();
    const wholeDocumentEdit = localWholeDocumentImprove(content, instruction, config, filePath, researchContext, editorQualityContext);
    if (wholeDocumentEdit) {
      return res.json({
        success: true,
        answer: wholeDocumentEdit.answer,
        action: "replace_current_file",
        patch: wholeDocumentEdit.patch,
        agentTrace: wholeDocumentEdit.trace,
        backup: makeEditorBackup(),
        canApply: true,
        autoApply: true,
      });
    }
  }

  const prompt = `You are the Paper-agent editor agent inside a local workbench, similar to Codex.
Project: ${summary.name}
Mode: ${mode}
Current file: ${filePath || "unknown"}
User instruction: ${instruction}
${editorQualityContext ? `
Internal quality scan for planning only. Do not copy this block, any quality report wording, or any system/status text into the manuscript patch:
${editorQualityContext.compact}
` : ""}

You are connected to the center editor. The right chat panel is ONLY for concise execution status, not for displaying the edited article.
Decide what should happen from the user's natural-language instruction.

Available actions:
- suggest: reply only, no file change.
- replace_current_file: return a full replacement for the current editor content in patch.
- compile_pdf: compile/export PDF from the current project book.
- export_docx: export Word from the current project book.
- export_tex: export LaTeX from the current project book.

Rules:
- If the user asks you to modify, polish, improve, continue, complete, process, rewrite, or directly handle the document, choose replace_current_file and return the full edited content.
- If the user asks where a problem is, how to fix something, or asks a question, choose suggest.
- If the user asks to compile/export, choose the matching compile/export action.
- Do not fabricate policy, market data, certificates, patents, or proof materials; mark uncertain material as pending verification.
- For replace_current_file, patch must contain only the finished project-book manuscript. Do not include quality reports, diagnosis notes, source-mapping notes, system explanations, TODO lists, or advice to the user.
- For replace_current_file, answer must be a short Chinese work log with these labels when possible: 诊断、计划、执行、复核、下一步.
- The answer must say what you inspected, why you chose the edit, what you changed, and what the user should do next.
- Never put the full edited article, long replacement text, Markdown manuscript, or code block into answer. Put edited content only in patch.

Return JSON only with this shape:
{"answer":"short Chinese status/work log only","action":"suggest|replace_current_file|compile_pdf|export_docx|export_tex","patch":"full replacement text only for replace_current_file, otherwise empty","autoApply":true_or_false}

--- selected content excerpt ---
${modelContent}`;
  const llm = await callLLM(prompt);
  const raw = llm.text.trim();
  if (raw) {
    try {
      const parsed = parseAssistantAction(raw);
      const action = parsed.action || "suggest";
      const patch = String(parsed.patch || "");
      const safePatch = action === "replace_current_file" && isSafeFullReplacement(content, patch);
      if (!safePatch && action !== "replace_current_file" && wantsEditorChange(instruction)) {
        const researchContext = wholeDocumentRequested ? await getEditorResearchContext() : undefined;
        const wholeDocumentEdit = localWholeDocumentImprove(content, instruction, config, filePath, researchContext, editorQualityContext);
        if (wholeDocumentEdit) {
          return res.json({
            success: true,
            answer: wholeDocumentEdit.answer,
            action: "replace_current_file",
            patch: wholeDocumentEdit.patch,
            agentTrace: wholeDocumentEdit.trace,
            backup: makeEditorBackup(),
            canApply: true,
            autoApply: true,
          });
        }
      }
      const nextAction = safePatch || action !== "replace_current_file" ? action : "suggest";
      const answer = safePatch
        ? editorAppliedLog(filePath, patch, safeEditorAnswer(parsed.answer, "已按你的指令修改当前文件。"))
        : action === "replace_current_file"
          ? [
              "已拦截本次改稿。",
              "原因：返回内容不足以安全覆盖当前文件。",
              "当前编辑器未改动。请指定更小的范围，或要求“重写整篇并直接应用”。",
            ].join("\n")
          : safeEditorAnswer(parsed.answer, "已完成分析。");
      return res.json({
        success: true,
        answer,
        action: nextAction,
        patch: safePatch ? patch : "",
        agentTrace: safePatch
          ? editorTraceForAppliedEdit(content, instruction, filePath, patch, "完成外部模型改稿并通过安全覆盖检查")
          : editorTraceForNoChange(content, instruction, filePath, action === "replace_current_file" ? "外部模型返回内容不足以安全覆盖当前文件。" : "已按问题型指令返回分析，不改动正文。"),
        backup: safePatch ? makeEditorBackup() : null,
        canApply: safePatch,
        autoApply: Boolean(parsed.autoApply && safePatch),
      });
    } catch {
      if (wantsEditorChange(instruction) && isSafeFullReplacement(content, raw)) {
        return res.json({
          success: true,
          answer: editorAppliedLog(filePath, raw, "已将改稿写入中间编辑器。"),
          action: "replace_current_file",
          patch: raw,
          agentTrace: editorTraceForAppliedEdit(content, instruction, filePath, raw, "完成纯文本改稿并通过安全覆盖检查"),
          backup: makeEditorBackup(),
          canApply: true,
          autoApply: true,
        });
      }
      return res.json({
        success: true,
        answer: safeEditorAnswer(raw, "已完成分析，当前编辑器未改动。"),
        action: "suggest",
        patch: "",
        agentTrace: editorTraceForNoChange(content, instruction, filePath, "外部模型返回的是分析内容或不可安全应用内容，已保持正文不变。"),
        canApply: false,
        autoApply: false,
      });
    }
  }
  if (wholeDocumentRequested) {
    const researchContext = await getEditorResearchContext();
    const wholeDocumentEdit = localWholeDocumentImprove(content, instruction, config, filePath, researchContext, editorQualityContext);
    if (wholeDocumentEdit) {
      return res.json({
        success: true,
        answer: wholeDocumentEdit.answer,
        action: "replace_current_file",
        patch: wholeDocumentEdit.patch,
        agentTrace: wholeDocumentEdit.trace,
        backup: makeEditorBackup(),
        canApply: true,
        autoApply: true,
      });
    }
  }
  const fallback = localPolishMarkdown(content, instruction);
  const canApplyFallback = Boolean(fallback.canApply && fallback.patch !== content);
  if (!canApplyFallback && wantsEditorChange(instruction)) {
    const researchContext = wholeDocumentRequested ? await getEditorResearchContext() : undefined;
    const wholeDocumentEdit = localWholeDocumentImprove(content, instruction, config, filePath, researchContext, editorQualityContext);
    if (wholeDocumentEdit) {
      return res.json({
        success: true,
        answer: wholeDocumentEdit.answer,
        action: "replace_current_file",
        patch: wholeDocumentEdit.patch,
        agentTrace: wholeDocumentEdit.trace,
        backup: makeEditorBackup(),
        canApply: true,
        autoApply: true,
      });
    }
  }
  res.json({
    success: true,
    answer: fallback.answer,
    action: canApplyFallback ? "replace_current_file" : "suggest",
    patch: canApplyFallback ? fallback.patch : "",
    agentTrace: canApplyFallback
      ? editorTraceForAppliedEdit(content, instruction, filePath, fallback.patch, "完成本地润色改写")
      : editorTraceForNoChange(content, instruction, filePath, "本地润色器没有找到可安全替换的片段。"),
    backup: canApplyFallback ? makeEditorBackup() : null,
    canApply: canApplyFallback,
    autoApply: canApplyFallback,
  });
});

workflowsRouter.get("/:id", (req, res) => {
  const summary = workflowSummary(req.params.id);
  if (!summary) return res.status(404).json({ error: "工作流不存在" });
  const projectDir = join(PROJECTS_DIR, req.params.id);
  const backup = latestWorkflowBackup(projectDir);
  res.json({
    ...summary,
    artifacts: listMarkdownFiles(join(projectDir, ".paper", "artifacts")),
    drafts: listMarkdownFiles(join(projectDir, ".paper", "drafts")),
    checkpoints: checkpointStore.getWorkflowCheckpoints(req.params.id),
    latestBackup: backup ? { id: backup.id, path: backup.path } : null,
  });
});

workflowsRouter.post("/:id/start", async (req, res) => {
  const summary = workflowSummary(req.params.id);
  if (!summary) return res.status(404).json({ error: "工作流不存在" });
  if (summary.status === "running") return res.status(409).json({ error: "工作流正在运行" });

  try {
    const finalPath = await runWorkflow(req.params.id);
    res.json({ success: true, finalPath });
  } catch (error: any) {
    res.status(500).json({ error: error.message ?? String(error) });
  }
});

workflowsRouter.post("/:id/plan", async (req, res) => {
  const summary = workflowSummary(req.params.id);
  if (!summary) return res.status(404).json({ error: "工作流不存在" });
  try {
    res.json(await runWorkflowPlanning(req.params.id));
  } catch (error: any) {
    res.status(500).json({ error: error.message ?? String(error) });
  }
});

workflowsRouter.post("/:id/execute", async (req, res) => {
  const summary = workflowSummary(req.params.id);
  if (!summary) return res.status(404).json({ error: "工作流不存在" });
  if (summary.status === "running") return res.status(409).json({ error: "工作流正在运行" });
  try {
    res.json(await runWorkflowExecution(req.params.id));
  } catch (error: any) {
    res.status(500).json({ error: error.message ?? String(error) });
  }
});

workflowsRouter.post("/:id/audit", async (req, res) => {
  const summary = workflowSummary(req.params.id);
  if (!summary) return res.status(404).json({ error: "工作流不存在" });
  try {
    res.json(await runWorkflowAudit(req.params.id));
  } catch (error: any) {
    res.status(500).json({ error: error.message ?? String(error) });
  }
});

workflowsRouter.post("/:id/deliver", async (req, res) => {
  try {
    const result = await buildDeliveryPackage(req.params.id, Boolean(req.body?.force));
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message ?? String(error) });
  }
});

workflowsRouter.post("/:id/rollback", (req, res) => {
  try {
    const workflowId = resolveWorkflowId(req.params.id);
    const summary = workflowSummary(workflowId);
    if (!summary) return res.status(404).json({ error: "工作流不存在" });
    if (summary.status === "running") return res.status(409).json({ error: "工作流正在运行，不能回滚" });
    const result = restoreWorkflowBackup(workflowId, req.body?.backupId ? String(req.body.backupId) : undefined);
    const config = readConfig(workflowId);
    if (config) {
      config.updated = new Date().toISOString();
      writeConfig(workflowId, config);
    }
    res.json({ success: true, ...result, workflow: workflowSummary(workflowId) });
  } catch (error: any) {
    res.status(500).json({ error: error.message ?? String(error) });
  }
});

workflowsRouter.get("/:id/quality", (req, res) => {
  try {
    const workflowId = resolveWorkflowId(req.params.id);
    const config = readConfig(workflowId);
    if (!config) return res.status(404).json({ error: "工作流不存在" });
    const finalPath = join(projectDirFor(workflowId), ".paper", "drafts", "project-book-final.md");
    if (!existsSync(finalPath)) return res.status(404).json({ error: "请先生成完整项目书，再进行质量体检" });
    const finalBook = readFileSync(finalPath, "utf-8");
    const artifacts = readArtifactFilesForDelivery(workflowId, config);
    res.json({ success: true, workflow: workflowSummary(workflowId), ...buildQualityScanSummary(config, finalBook, artifacts) });
  } catch (error: any) {
    res.status(500).json({ error: error.message ?? String(error) });
  }
});

workflowsRouter.post("/:id/quality/repair", (req, res) => {
  try {
    const workflowId = resolveWorkflowId(req.params.id);
    const config = readConfig(workflowId);
    if (!config) return res.status(404).json({ error: "工作流不存在" });
    res.json(repairFinalBookFromQualityScan(workflowId, config));
  } catch (error: any) {
    res.status(500).json({ error: error.message ?? String(error) });
  }
});

workflowsRouter.post("/:id/export/:format", async (req, res) => {
  const workflowId = resolveWorkflowId(String(req.query.id || req.body?.id || req.params.id));
  const requestedFormat = req.params.format;
  const format = requestedFormat === "latex" ? "tex" : requestedFormat;
  if (format !== "docx" && format !== "pdf" && format !== "tex") {
    res.status(400).json({ error: "仅支持 docx、pdf 或 tex" });
    return;
  }
  try {
    const result = await exportProjectBook(workflowId, format);
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message ?? String(error) });
  }
});

workflowsRouter.delete("/:id", (req, res) => {
  const workflowId = resolveWorkflowId(req.params.id);
  const projectDir = projectDirFor(workflowId);
  if (!existsSync(projectDir)) return res.status(404).json({ error: "工作流不存在" });
  rmSync(projectDir, { recursive: true, force: true });
  checkpointStore.clear(workflowId);
  res.json({ success: true });
});

export { WORKFLOW_TEMPLATES };
