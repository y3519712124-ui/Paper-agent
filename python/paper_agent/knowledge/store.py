# ============================================================
# 知识库 (Python) — 向量检索
# ============================================================

"""
知识库模块。

基于 sentence-transformers 的本地向量检索。
支持导入和管理参考材料（获奖案例、政策文件等）。
"""

from typing import List, Dict, Optional, Any
import json
import os


class KnowledgeStore:
    """知识库——本地向量存储和检索"""

    def __init__(self, storage_dir: str = ".paper/knowledge"):
        self.storage_dir = storage_dir
        self._documents: List[Dict[str, Any]] = []
        self._embeddings = None  # sentence-transformers 模型（按需加载）
        os.makedirs(storage_dir, exist_ok=True)

    def add_document(self, title: str, content: str, category: str = "general", source: str = ""):
        """添加文档到知识库"""
        doc = {
            "id": f"doc-{len(self._documents)}",
            "title": title,
            "content": content,
            "category": category,
            "source": source,
            "added": __import__('datetime').datetime.now().isoformat(),
        }
        self._documents.append(doc)
        return doc["id"]

    def search(self, query: str, top_k: int = 5, category: Optional[str] = None) -> List[Dict]:
        """搜索相关文档（目前基于关键词，后续接入向量检索）"""
        results = []
        query_lower = query.lower()

        for doc in self._documents:
            if category and doc.get("category") != category:
                continue

            # 简单关键词匹配
            if query_lower in doc["title"].lower() or query_lower in doc["content"].lower():
                results.append(doc)

        # 按相关性排序（简化）
        return results[:top_k]

    def get_document(self, doc_id: str) -> Optional[Dict]:
        """获取单个文档"""
        for doc in self._documents:
            if doc["id"] == doc_id:
                return doc
        return None

    def list_categories(self) -> List[str]:
        """列出所有分类"""
        return list(set(doc.get("category", "general") for doc in self._documents))

    def stats(self) -> dict:
        """知识库统计"""
        return {
            "total_documents": len(self._documents),
            "categories": self.list_categories(),
        }

    def save(self, path: Optional[str] = None):
        """持久化到磁盘"""
        save_path = path or os.path.join(self.storage_dir, "knowledge.json")
        with open(save_path, "w", encoding="utf-8") as f:
            json.dump(self._documents, f, ensure_ascii=False, indent=2)

    def load(self, path: Optional[str] = None):
        """从磁盘加载"""
        load_path = path or os.path.join(self.storage_dir, "knowledge.json")
        if os.path.exists(load_path):
            with open(load_path, "r", encoding="utf-8") as f:
                self._documents = json.load(f)
