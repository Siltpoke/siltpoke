# Absolute dotted import; the real file is src/mypkg/models.py → source root = src/.
# (repo-root anchoring would look for ./mypkg/models.py and miss — that is the bug fixed.)
from mypkg.models import X

Y = X
