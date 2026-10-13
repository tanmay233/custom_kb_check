from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator


Name = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=120)]


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class GraphCreate(StrictModel):
    name: Name


class NodeType(StrictModel):
    id: UUID
    name: Name


class RelationshipType(NodeType):
    from_type_id: UUID
    to_type_id: UUID


class Node(NodeType):
    type_id: UUID
    description: str = Field(default="", max_length=10000)


class Edge(StrictModel):
    id: UUID
    type_id: UUID
    source_id: UUID
    target_id: UUID


class GraphSave(StrictModel):
    name: Name
    revision: int = Field(ge=0)
    node_types: list[NodeType] = Field(default_factory=list, max_length=500)
    relationship_types: list[RelationshipType] = Field(default_factory=list, max_length=1000)
    nodes: list[Node] = Field(default_factory=list, max_length=10000)
    edges: list[Edge] = Field(default_factory=list, max_length=30000)

    @model_validator(mode="after")
    def valid_graph(self):
        collections = [self.node_types, self.relationship_types, self.nodes, self.edges]
        ids = [item.id for collection in collections for item in collection]
        if len(ids) != len(set(ids)):
            raise ValueError("Every type, node, and relationship must have a unique UUID.")
        for items in (self.node_types, self.relationship_types):
            names = [item.name.casefold() for item in items]
            if len(names) != len(set(names)):
                raise ValueError("Type names must be unique within the graph (case-insensitive).")
        types = {item.id for item in self.node_types}
        rel_types = {item.id: item for item in self.relationship_types}
        nodes = {item.id: item for item in self.nodes}
        for rel in self.relationship_types:
            if rel.from_type_id not in types or rel.to_type_id not in types:
                raise ValueError("Relationship definitions must reference existing node types.")
        for node in self.nodes:
            if node.type_id not in types:
                raise ValueError("Every node must reference an existing node type.")
        mappings = set()
        for edge in self.edges:
            rel = rel_types.get(edge.type_id)
            source, target = nodes.get(edge.source_id), nodes.get(edge.target_id)
            if not rel or not source or not target:
                raise ValueError("Relationships must reference existing definitions and nodes.")
            if source.type_id != rel.from_type_id or target.type_id != rel.to_type_id:
                raise ValueError("Relationship endpoints do not match the allowed node types.")
            mapping = (edge.type_id, edge.source_id, edge.target_id)
            if mapping in mappings:
                raise ValueError("This relationship between these nodes already exists.")
            mappings.add(mapping)
        return self


class SearchRequest(StrictModel):
    query: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=2000)]
    mode: Literal["vector", "semantic", "cypher"] = "vector"
    limit: int = Field(default=5, ge=1, le=100, strict=True)
    node_type_id: UUID | None = None

    @model_validator(mode="after")
    def valid_search(self):
        if self.mode == "cypher" and self.node_type_id is not None:
            raise ValueError("Cypher filters may use node names, node UUIDs, and relationship names only; node_type_id is not supported.")
        if self.mode == "cypher" and "limit" not in self.model_fields_set:
            self.limit = 100
        return self
