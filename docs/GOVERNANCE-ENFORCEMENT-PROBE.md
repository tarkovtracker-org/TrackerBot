# Disposable repository enforcement probe

This file exists only on a temporary validation branch, never on the default
branch. The initial candidate deliberately fails an isolated test. A subsequent
commit removes that test so CI can pass while the independent maintainer approval
is still absent. Both states must be blocked by the same rules as the default
branch. Close the probe PR and delete its branches after collecting evidence;
never weaken default-branch protection or manufacture a maintainer approval.
