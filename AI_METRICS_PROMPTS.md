# AI Assistant Prompts for Agile & DORA Metrics

## How AI Can Use These Tools

The AI assistant can respond to natural language queries about metrics by combining multiple MCP tools and the working data cache. Here are example conversations showing how the AI would use the tools:

## 🏃 Agile Metrics Conversations

### Sprint Velocity Analysis
**User**: "What's our team velocity trend?"

**AI Actions**:
1. Call `get_sprint_metrics` for last 6 sprints
2. Check cache for historical velocity data
3. Calculate trend (increasing/stable/decreasing)
4. Generate insights

**AI Response**:
```
Your team's velocity over the last 6 sprints:
• Sprint 23: 34 points ✅
• Sprint 24: 31 points
• Sprint 25: 38 points ✅
• Sprint 26: 35 points
• Sprint 27: 33 points
• Sprint 28: 36 points (current)

📊 Analysis:
- Average velocity: 34.5 story points
- Trend: STABLE (±3 points variation)
- Predictability: HIGH (88% within range)

💡 Insights:
- Your team delivers consistently between 31-38 points
- Current sprint on track with 36 points committed
- Consider capacity of 34 points for next sprint planning
```

### Cycle Time Investigation
**User**: "Why is our cycle time increasing?"

**AI Actions**:
1. Call `calculate_flow_metrics` for current vs previous period
2. Call `get_cumulative_flow` to identify bottlenecks
3. Analyze work item history for stuck items
4. Check WIP limits

**AI Response**:
```
I've analyzed your cycle time increase:

Current vs Previous Month:
• Current cycle time: 8.3 days (↑ 2.1 days)
• Previous cycle time: 6.2 days

🔍 Root Causes Identified:

1. **Code Review Bottleneck** (40% of increase)
   - 5 items waiting >3 days for review
   - Reviewer capacity reduced by 50%
   
2. **Testing Queue** (35% of increase)
   - QA environment issues last week
   - 8 items backed up in testing
   
3. **Increased WIP** (25% of increase)
   - Current WIP: 18 items (limit: 12)
   - Team working on too many items simultaneously

📋 Recommendations:
1. Add backup code reviewers
2. Fix QA environment stability
3. Enforce WIP limits
4. Consider pair programming for faster reviews
```

### Sprint Health Check
**User**: "Are we going to complete this sprint?"

**AI Actions**:
1. Get current sprint burndown
2. Calculate completion probability
3. Identify at-risk items
4. Check team capacity

**AI Response**:
```
Sprint 28 Health Check (Day 7 of 10):

📊 Current Status:
• Completed: 22 of 36 points (61%)
• Remaining: 14 points
• Days left: 3
• Required velocity: 4.7 points/day

⚠️ Risk Assessment: MEDIUM RISK

At-Risk Items:
1. USER-1234: "Payment integration" (5 points)
   - Blocked by external dependency
   - 70% chance of carry-over
   
2. USER-1456: "Report redesign" (3 points)
   - Not started yet
   - 50% chance of completion

✅ Confident Items:
- 6 points in testing (90% completion likely)
- 3 points in review (95% completion likely)

Prediction: 28-31 points likely completed (78-86%)

💡 Actions to improve:
1. Escalate USER-1234 blocker immediately
2. Start USER-1456 today or defer to next sprint
3. Focus team on completing in-progress items
```

## 🚀 DORA Metrics Conversations

### Performance Assessment
**User**: "What are our DORA metrics?"

**AI Actions**:
1. Call `calculate_dora_metrics` for current period
2. Compare with previous period
3. Classify performance level
4. Generate recommendations

**AI Response**:
```
DORA Metrics Dashboard - Q4 2024

📊 Current Performance Level: HIGH PERFORMER

1. **Deployment Frequency**: 3.2 per day
   • Classification: HIGH (Elite: >1/day)
   • Trend: ↑ 18% from Q3
   
2. **Lead Time for Changes**: 18 hours
   • Classification: HIGH (Elite: <1 hour)
   • Trend: ↓ 15% improvement from Q3
   
3. **MTTR**: 45 minutes
   • Classification: ELITE (Elite: <1 hour)
   • Trend: ↓ 25% improvement from Q3
   
4. **Change Failure Rate**: 12%
   • Classification: ELITE (Elite: <15%)
   • Trend: ↓ 3% improvement from Q3

📈 Quarter-over-Quarter:
• Moved from MEDIUM to HIGH performer
• Biggest improvement: MTTR (2 hours → 45 min)
• Focus area: Lead time (aim for <1 hour)

🎯 To reach ELITE status:
1. Reduce lead time by 17 hours
2. Increase deployment frequency to >5/day
3. Maintain current MTTR and failure rate

Would you like detailed analysis of any metric?
```

### Deployment Issues
**User**: "Show me our deployment failures this week"

**AI Actions**:
1. Call `get_deployment_metrics` with failure filter
2. Call `get_incident_metrics` for related incidents
3. Analyze patterns
4. Calculate impact

**AI Response**:
```
Deployment Failures - Week of Dec 9-15, 2024

📊 Summary:
• Total deployments: 18
• Failed deployments: 3 (16.7%)
• Rollbacks: 2
• Hotfixes: 1

Failed Deployments:

1. **API Service v2.3.1** - Dec 10, 14:30
   • Failure: Database migration error
   • MTTR: 32 minutes
   • Impact: 1,200 users affected
   • Root cause: Missing migration script
   • Action: Rolled back, fixed, redeployed

2. **Frontend v4.1.0** - Dec 12, 09:15
   • Failure: CSS bundle corruption
   • MTTR: 18 minutes
   • Impact: All users (visual issues only)
   • Root cause: Build pipeline memory issue
   • Action: Hotfix deployed

3. **Payment Service v1.8.2** - Dec 14, 16:45
   • Failure: Configuration error
   • MTTR: 8 minutes
   • Impact: 0 users (caught in staging)
   • Root cause: Environment variable missing
   • Action: Config fixed, redeployed

📊 Pattern Analysis:
• 67% failures due to configuration/build issues
• 33% due to code defects
• Friday deployments 2x more likely to fail

💡 Recommendations:
1. Add configuration validation to pipeline
2. Increase build pipeline resources
3. Implement deployment freeze on Fridays
4. Add automated rollback triggers
```

## 📊 Complex Analytics Queries

### Team Comparison
**User**: "Compare our three product teams' performance"

**AI Actions**:
1. Call metrics for each team
2. Aggregate and normalize data
3. Create comparison matrix
4. Identify best practices

**AI Response**:
```
Team Performance Comparison - Q4 2024

Team A: Payments     | Team B: Platform    | Team C: Mobile
--------------------|--------------------|-----------------
Velocity: 42 pts    | Velocity: 38 pts   | Velocity: 35 pts
Cycle Time: 5.2d    | Cycle Time: 7.1d   | Cycle Time: 4.8d ⭐
Lead Time: 8.5d     | Lead Time: 12.3d   | Lead Time: 7.2d ⭐
Deploy/Day: 4.2 ⭐   | Deploy/Day: 2.1    | Deploy/Day: 3.5
MTTR: 28 min ⭐      | MTTR: 52 min       | MTTR: 41 min
Bugs/Sprint: 3.2    | Bugs/Sprint: 5.1   | Bugs/Sprint: 2.8 ⭐
WIP Limit: 8        | WIP Limit: 12      | WIP Limit: 6

🏆 Best Practices to Share:
• Team A: Automated deployment pipeline (4.2 deploys/day)
• Team C: Small WIP limits improve cycle time
• Team A: On-call rotation reduces MTTR

⚠️ Areas for Improvement:
• Team B: Reduce WIP from 12 to 8
• Team B: Implement Team A's deployment practices
• Team A: Adopt Team C's testing practices (fewer bugs)

Overall Performance:
1. Team A: HIGH performer (DORA)
2. Team C: Highest quality, fastest delivery
3. Team B: Needs focus on flow efficiency
```

### Predictive Analytics
**User**: "When will we finish the authentication epic?"

**AI Actions**:
1. Get remaining work items in epic
2. Calculate team velocity trend
3. Factor in dependencies and risks
4. Generate Monte Carlo simulation

**AI Response**:
```
Authentication Epic Completion Forecast

📊 Epic Status:
• Completed: 68 story points (42%)
• Remaining: 94 story points
• Items: 23 remaining (8 blocked)

📈 Velocity Analysis:
• Last 6 sprints average: 34 points
• Trend: Stable (±3 points)
• Team capacity next sprint: -2 developers (vacation)

📅 Completion Predictions:

OPTIMISTIC (85% confidence):
• Date: February 28, 2025
• Sprints needed: 3
• Assumes: No new blockers, maintain velocity

LIKELY (50% confidence):
• Date: March 14, 2025
• Sprints needed: 3.5
• Assumes: Current velocity, 1-2 minor delays

PESSIMISTIC (95% confidence):
• Date: March 28, 2025
• Sprints needed: 4
• Assumes: Reduced capacity, typical delays

🚧 Risk Factors:
1. 8 items blocked by security review (impact: +5 days)
2. Team capacity reduced in Sprint 30 (impact: +3 days)
3. Dependency on Platform team (impact: unknown)

💡 To accelerate:
1. Resolve security review blockers NOW
2. Add 1 developer from Team B
3. Defer non-critical features (save 15 points)

With suggested actions: Could complete by Feb 21 ✅
```

## 🤖 Proactive AI Insights

The AI can proactively offer insights when it detects issues:

### Automatic Alerts
```
🚨 Metric Alert: Cycle time increased 40% this week

I noticed your cycle time jumped from 5.2 to 7.3 days. 
Main bottleneck: 12 items stuck in "Code Review" state.

Would you like me to:
1. Show which PRs need review?
2. Identify available reviewers?
3. Analyze review time patterns?
```

### Weekly Summary
```
📊 Weekly Metrics Summary - Team Platform

Highlights:
✅ Deployment frequency up 25% (2.1 → 2.6/day)
✅ Zero production incidents (7 days streak!)
⚠️ Velocity dropped 15% (38 → 32 points)
🔴 3 items carried over to next sprint

Key Insights:
• Deployment improvements working well
• Team impacted by 2 sick days
• Consider adjusting sprint capacity

Recommendations for next week:
1. Plan for 32 points (adjusted capacity)
2. Celebrate the zero-incident streak
3. Continue deployment automation efforts
```

## 📝 Natural Language Understanding

The AI understands various ways to ask for the same metrics:

### Velocity Queries
- "What's our velocity?"
- "How many points do we complete?"
- "Show me sprint throughput"
- "What's our team capacity?"
- "How much work do we deliver?"

### DORA Queries
- "How often do we deploy?"
- "What's our release frequency?"
- "How long to get code to production?"
- "What's our recovery time?"
- "How many deployments fail?"

### Quality Queries
- "How many bugs do we have?"
- "What's our defect rate?"
- "Show me quality metrics"
- "Are we creating technical debt?"

## 🎯 Actionable Insights

The AI always provides:
1. **Current State** - Where you are now
2. **Trend** - Where you're heading
3. **Comparison** - How you compare (team/industry)
4. **Root Cause** - Why it's happening
5. **Actions** - What to do about it
6. **Impact** - Expected outcome of actions

This enables teams to make data-driven decisions quickly and confidently.