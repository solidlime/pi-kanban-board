
import io
p = "extensions/kanban.ts"
s = io.open(p, encoding="utf-8", newline="").read()

a = "\"Open a card when a request needs three or more separate deliverables \u2014\","
assert s.count(a) == 1, "line not found"
b = "\"Open a card when a request needs three or more separate pieces of work \u2014\","
s = s.replace(a, b)

c = """ * (/api/deliv/remove and /api/attach/del) with the same expression; owner names the space
 * being changed, so a card id and a deliverable id can never be confused for each other.
 */"""
d = """ * (/api/deliv/remove and /api/attach/del) with the same expression; owner names the space
 * being changed, so a card id and a deliverable id can never be confused for each other.
 *
 * Not yet the one rule everywhere: the three card-delete paths still call removeMedia(card),
 * which trashes unconditionally. Harmless today - writeMedia names files with an owner prefix
 * plus randHex8(), so a card and a deliverable can never end up sharing one, and no copy path
 * exists either - but if a shared name ever becomes possible, those three are the holes.
 */"""
assert s.count(c) == 1, "docstring not found"
s = s.replace(c, d)
io.open(p, "w", encoding="utf-8", newline="").write(s)
print("patched")
